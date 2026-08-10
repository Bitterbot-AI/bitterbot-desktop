/**
 * PLAN-40 Phase 1 — Lane 2: memory hygiene.
 *
 * The evidence-backed consolidation lane (Letta sleep-time agents, Anthropic
 * Dreaming, Mem0): three bounded, mechanical-trigger operations per cycle —
 *
 *  1a. Embedding backfill — drains the never-embedded crystal backlog via the
 *      manager's existing backfillPendingEmbeddings op (cursorless: the work
 *      predicate is self-consuming, so rowid reuse after the forgetting
 *      engine's deletes cannot strand it — adversarial F11).
 *  1b. Near-duplicate merge — clusters NON-SKILL chunks at cosine >=
 *      MERGE_SIMILARITY, writes ONE merged summary via the ops callback,
 *      which demotes members transactionally (their vec/FTS index rows are
 *      DELETED — lifecycle marking alone removes nothing from retrieval,
 *      adversarial F1/E11). One-shot: hygiene_done rows and consolidated
 *      rows are never re-selected (bounded rewriting, arXiv 2605.12978).
 *      Skill crystals are excluded entirely — consolidation would silently
 *      exit them from the refiner/publish/execution-credit surfaces
 *      (adversarial F3); the legacy paraphrase pile is a one-time
 *      supervised cleanup instead.
 *  1c. Canonical staleness questions — facts unconfirmed for STALE_AFTER
 *      enqueue ONE "still true?" line into the PLAN-34 surfacing queue.
 *      Ask-stamp is written only AFTER a successful enqueue; 3 asks without
 *      confirmation transitions the fact to 'unconfirmed' (a real terminal
 *      state — no forever-loop, adversarial F14).
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordDreamArtifact } from "../dream-utility.js";
import { cosineSimilarity, parseEmbedding } from "../internal.js";

const log = createSubsystemLogger("memory/dream-hygiene");

/** Cosine floor for two chunks to count as near-duplicates. */
export const MERGE_SIMILARITY = 0.92;
/** Max member chunks fed to one merge summary. */
const MERGE_MAX_MEMBERS = 6;
/** Max merge clusters (= LLM calls) per cycle. */
const MERGE_MAX_PER_CYCLE = 2;
/** Candidate pool size per cycle for clustering. */
const MERGE_CANDIDATE_POOL = 200;
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
  /**
   * Transactional merge write: insert the summary chunk (embedded + FTS/vec
   * indexed), then demote members (lifecycle='consolidated',
   * parent_id=summary CHUNK id, hygiene_done=1) AND delete their vec/FTS
   * rows — all in one transaction. Returns the summary chunk id, or null on
   * failure (in which case NOTHING was changed).
   */
  writeMergedSummary(params: {
    text: string;
    memberIds: string[];
    semanticType: string;
  }): Promise<string | null>;
};

export type HygieneResult = {
  backfilled: number;
  merged: number;
  staleAsks: number;
  factsMarkedUnconfirmed: number;
  llmCalls: number;
  chunksProcessed: number;
};

const EMPTY: HygieneResult = {
  backfilled: 0,
  merged: 0,
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

/** Greedy near-duplicate clustering over the candidate pool. */
export function findMergeClusters(
  candidates: Array<{ id: string; semantic_type: string; embedding: number[] }>,
  maxClusters: number,
): Array<{ semanticType: string; memberIds: string[] }> {
  const used = new Set<string>();
  const clusters: Array<{ semanticType: string; memberIds: string[] }> = [];
  for (let i = 0; i < candidates.length && clusters.length < maxClusters; i++) {
    const a = candidates[i]!;
    if (used.has(a.id)) continue;
    const members = [a.id];
    for (let j = i + 1; j < candidates.length && members.length < MERGE_MAX_MEMBERS; j++) {
      const b = candidates[j]!;
      if (used.has(b.id) || b.semantic_type !== a.semantic_type) continue;
      if (cosineSimilarity(a.embedding, b.embedding) >= MERGE_SIMILARITY) {
        members.push(b.id);
      }
    }
    if (members.length >= 2) {
      for (const id of members) used.add(id);
      clusters.push({ semanticType: a.semantic_type, memberIds: members });
    }
  }
  return clusters;
}

export async function runHygiene(params: {
  db: DatabaseSync;
  llmCall: ((prompt: string) => Promise<string>) | null;
  ops: HygieneOps | null;
  /** True remaining LLM budget for this cycle (engine-managed). */
  llmBudget: number;
  cycleId: string;
  now?: number;
}): Promise<HygieneResult> {
  const { db, llmCall, ops, cycleId } = params;
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

  // ── 1b. Near-duplicate merge (bounded LLM) ──
  if (llmCall && params.llmBudget > 0) {
    try {
      const rows = db
        .prepare(
          `SELECT id, semantic_type, embedding FROM chunks
            WHERE COALESCE(semantic_type, 'general') NOT IN ('skill')
              AND COALESCE(memory_type, '') != 'skill'
              AND COALESCE(hygiene_done, 0) = 0
              AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated')
              AND COALESCE(lifecycle_state, 'active') = 'active'
              AND origin IS NOT 'dream'
              AND json_valid(embedding) AND json_array_length(embedding) > 0
            ORDER BY updated_at DESC
            LIMIT ?`,
        )
        .all(MERGE_CANDIDATE_POOL) as Array<{
        id: string;
        semantic_type: string;
        embedding: string;
      }>;
      const candidates = rows
        .map((r) => ({
          id: r.id,
          semantic_type: r.semantic_type ?? "general",
          embedding: parseEmbedding(r.embedding),
        }))
        .filter((r) => r.embedding.length > 0);
      const clusters = findMergeClusters(
        candidates,
        Math.min(MERGE_MAX_PER_CYCLE, params.llmBudget),
      );
      for (const cluster of clusters) {
        const texts = cluster.memberIds
          .map(
            (id) =>
              (db.prepare(`SELECT text FROM chunks WHERE id = ?`).get(id) as { text: string })
                ?.text ?? "",
          )
          .filter(Boolean);
        if (texts.length < 2) continue;
        result.llmCalls++;
        let summary: string;
        try {
          const raw = await llmCall(
            `These ${texts.length} stored memory notes say nearly the same thing. ` +
              `Merge them into ONE canonical note that preserves every distinct fact, ` +
              `name, number, and date. Output ONLY the merged note text, no preamble.\n\n` +
              texts.map((t, i) => `--- note ${i + 1} ---\n${t.slice(0, 1200)}`).join("\n"),
          );
          summary = raw.trim();
        } catch (err) {
          log.debug(`hygiene merge LLM failed: ${String(err)}`);
          continue;
        }
        if (!summary || summary.length < 20) continue;
        const summaryId = await ops.writeMergedSummary({
          text: summary,
          memberIds: cluster.memberIds,
          semanticType: cluster.semanticType,
        });
        if (summaryId) {
          result.merged++;
          result.chunksProcessed += cluster.memberIds.length;
          recordDreamArtifact(db, {
            lane: "hygiene",
            artifactKind: "merged_chunk",
            artifactId: summaryId,
            cycleId,
          });
        }
      }
    } catch (err) {
      log.debug(`hygiene merge failed: ${String(err)}`);
    }
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
