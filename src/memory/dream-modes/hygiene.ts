/**
 * PLAN-40 Phase 1 — Lane 2: memory hygiene.
 *
 * Two bounded, mechanical-trigger operations per cycle:
 *
 *  1a. Embedding backfill — drains the never-embedded crystal backlog via the
 *      manager's existing backfillPendingEmbeddings op (cursorless: the work
 *      predicate is self-consuming, so rowid reuse after the forgetting
 *      engine's deletes cannot strand it — adversarial F11).
 *  1c. Canonical staleness questions — facts unconfirmed for STALE_AFTER
 *      enqueue ONE "still true?" line into the PLAN-34 surfacing queue.
 *      Ask-stamp is written only AFTER a successful enqueue; 3 asks without
 *      confirmation transitions the fact to 'unconfirmed' (a real terminal
 *      state — no forever-loop, adversarial F14).
 *
 * There WAS a 1b — a near-duplicate merge that consolidated cosine-similar
 * chunks into LLM summaries and demoted the members out of the index. It was
 * deleted 2026-08-14 after failing its pre-registered D2 gate: across 23 real
 * replayed queries on state copies differing only by the merge, 0 top-5
 * changes, −0.1% injected tokens (plan40-phase-adversarial-2026-08-11.md).
 * Its ~19 summaries and their demoted members remain valid data in live
 * stores, so the demotion-preserving machinery (re-index carry-over, the FTS
 * drift fence, compression's hygiene_done skip) stays. If chunk redundancy is
 * attacked again, target what actually surfaces (handover/session summaries,
 * measured top-5 redundancy ~0.65) — not cosine neighbors at large.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory/dream-hygiene");

/** Embedding backfill batch per cycle. */
const BACKFILL_PER_CYCLE = 200;
/** A canonical fact this stale gets a "still true?" ask. */
const STALE_AFTER_MS = 90 * 24 * 60 * 60_000;
/** Never re-ask the same fact within this window. */
const STALE_REASK_MS = 30 * 24 * 60 * 60_000;
/** Asks before the fact transitions to 'unconfirmed' instead of re-asking. */
const STALE_MAX_ASKS = 3;
/** Staleness asks enqueued per cycle. */
const STALE_ASKS_PER_CYCLE = 2;

export type HygieneOps = {
  /** The manager's existing pending-embedding drainer. */
  backfillEmbeddings(limit: number): Promise<{ embedded: number; remaining: number }>;
};

export type HygieneResult = {
  backfilled: number;
  staleAsks: number;
  factsMarkedUnconfirmed: number;
  llmCalls: number;
  chunksProcessed: number;
};

const EMPTY: HygieneResult = {
  backfilled: 0,
  staleAsks: 0,
  factsMarkedUnconfirmed: 0,
  llmCalls: 0,
  chunksProcessed: 0,
};

function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    return Boolean(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),
    );
  } catch {
    return false;
  }
}

export async function runHygiene(params: {
  db: DatabaseSync;
  ops: HygieneOps | null;
  cycleId: string;
  now?: number;
}): Promise<HygieneResult> {
  const { db, ops } = params;
  const now = params.now ?? Date.now();
  const result: HygieneResult = { ...EMPTY };
  if (!ops) {
    return result;
  }

  // ── 1a. Embedding backfill (no LLM, cursorless) ──
  try {
    const bf = await ops.backfillEmbeddings(BACKFILL_PER_CYCLE);
    result.backfilled = bf.embedded;
    result.chunksProcessed += bf.embedded;
  } catch (err) {
    log.debug(`hygiene backfill failed: ${String(err)}`);
  }

  // ── 1c. Canonical staleness questions (no LLM) ──
  if (tableExists(db, "canonical_facts") && tableExists(db, "research_findings")) {
    try {
      const stale = db
        .prepare(
          `SELECT id, key, statement, staleness_asked_count
             FROM canonical_facts
            WHERE status = 'active'
              AND COALESCE(last_confirmed_at, first_seen_at) < ?
              AND (last_staleness_ask_at IS NULL OR last_staleness_ask_at < ?)
            ORDER BY COALESCE(last_confirmed_at, first_seen_at) ASC
            LIMIT ?`,
        )
        .all(now - STALE_AFTER_MS, now - STALE_REASK_MS, STALE_ASKS_PER_CYCLE) as Array<{
        id: string;
        key: string;
        statement: string | null;
        staleness_asked_count: number;
      }>;
      for (const fact of stale) {
        if (fact.staleness_asked_count >= STALE_MAX_ASKS) {
          // Terminal state: stop asking, mark honestly unconfirmed.
          db.prepare(`UPDATE canonical_facts SET status = 'unconfirmed' WHERE id = ?`).run(fact.id);
          result.factsMarkedUnconfirmed++;
          continue;
        }
        const question =
          `Still true: ${(fact.statement ?? fact.key).slice(0, 200)}? ` +
          `(last confirmed a while ago — a quick yes/no updates my records)`;
        // Enqueue FIRST; stamp only after success (adversarial F14: a failed
        // enqueue after stamping would silence the fact for 30 days).
        db.prepare(
          `INSERT INTO research_findings (id, target_id, finding, relevance, created_at)
           VALUES (?, ?, ?, 1.0, ?)`,
        ).run(crypto.randomUUID(), `canonical:${fact.id}`, question, now);
        db.prepare(
          `UPDATE canonical_facts
              SET staleness_asked_count = staleness_asked_count + 1,
                  last_staleness_ask_at = ?
            WHERE id = ?`,
        ).run(now, fact.id);
        result.staleAsks++;
      }
    } catch (err) {
      log.debug(`hygiene staleness failed: ${String(err)}`);
    }
  }

  return result;
}
