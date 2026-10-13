/**
 * PLAN-55 Phase 2 (G4), consumer 6: dream insights resting on stale evidence.
 *
 * Two halves:
 * - On `canonical:changed`, dream insights whose content states the old
 *   value (token-aware match, the same rules as search) or whose source
 *   chunks were just marked superseded for the key get a `stale_fact` JSON
 *   note (migration v78). A pin back to the old value clears the notes it
 *   wrote.
 * - At promotion time, insightPromotionBlock() is the gate the dream
 *   engine consults per candidate: an insight is not promoted when it is
 *   flagged, when any of its source chunks carries a supersession mark, or
 *   when any source chunk was forgotten by the owner (an `owner_forget`
 *   audit row; ordinary lifecycle decay does not count, it is not a
 *   statement that the memory was wrong). The forgotten-evidence case is
 *   recorded on the insight too, so the next cycle skips it without the
 *   lookups.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { staleCitationMatcher, yieldToEventLoop } from "./canonical-stale-match.js";
import { normalizeExact } from "./memory-suppressions.js";

const log = createSubsystemLogger("memory/canonical-propagation");

export const INSIGHT_WINDOW_ROWS = 500;
export const MAX_INSIGHT_ROWS_PER_EVENT = 20_000;

export type InsightStaleNote =
  | { reason: "superseded"; key: string; oldValue: string; factId: string; at: number }
  | { reason: "forgotten_evidence"; chunkIds: string[]; at: number };

export type InsightPropagationResult = { flagged: number; cleared: number };

const parseIds = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** The insight's notes (a list; a single legacy object is accepted). */
export function parseInsightNotes(raw: string | null): InsightStaleNote[] {
  if (!raw) {
    return [];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : [v];
    return list.filter(
      (n): n is InsightStaleNote =>
        Boolean(n) &&
        typeof n === "object" &&
        typeof (n as { reason?: unknown }).reason === "string",
    );
  } catch {
    return [];
  }
}

export async function propagateToDreamInsights(
  db: DatabaseSync,
  event: CanonicalChangeEvent,
): Promise<InsightPropagationResult> {
  const result: InsightPropagationResult = { flagged: 0, cleared: 0 };
  try {
    if (event.newValue) {
      result.cleared = clearInsightFlags(db, event.key, event.newValue);
    }
    if (!canonicalChangeMarksStale(event)) {
      return result;
    }
    const matcher = staleCitationMatcher(event);
    if (!matcher) {
      return result;
    }
    const markedChunks = new Set(
      (
        db
          .prepare(
            `SELECT chunk_id FROM chunk_supersessions WHERE fact_key = ? AND stale_value = ?
              ORDER BY created_at DESC LIMIT 1000`,
          )
          .all(event.key, normalizeExact(event.oldValue!)) as Array<{ chunk_id: string }>
      ).map((r) => r.chunk_id),
    );
    const note: InsightStaleNote = {
      reason: "superseded",
      key: event.key,
      oldValue: event.oldValue!,
      factId: event.factId,
      at: event.at,
    };
    // Newest first, so the per-event cap keeps the insights still in play.
    const page = db.prepare(
      `SELECT rowid AS rid, id, content, source_chunk_ids, stale_fact FROM dream_insights
        WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
    );
    const flag = db.prepare(`UPDATE dream_insights SET stale_fact = ? WHERE id = ?`);
    let before = Number.MAX_SAFE_INTEGER;
    let scanned = 0;
    while (scanned < MAX_INSIGHT_ROWS_PER_EVENT) {
      const rows = page.all(before, INSIGHT_WINDOW_ROWS) as unknown as Array<{
        rid: number;
        id: string;
        content: string;
        source_chunk_ids: string | null;
        stale_fact: string | null;
      }>;
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        const restsOnMarked =
          markedChunks.size > 0 &&
          parseIds(row.source_chunk_ids).some((id) => markedChunks.has(id));
        if (!matcher.cites(row.content) && !restsOnMarked) {
          continue;
        }
        const notes = parseInsightNotes(row.stale_fact);
        if (notes.some((n) => n.reason === "superseded" && n.key === event.key)) {
          continue;
        }
        result.flagged += Number(flag.run(JSON.stringify([...notes, note]), row.id).changes);
      }
      scanned += rows.length;
      before = rows[rows.length - 1]!.rid;
      await yieldToEventLoop();
    }
  } catch (err) {
    log.debug(`dream insight stale flagging skipped: ${String(err)}`);
  }
  if (result.flagged > 0) {
    log.info(`canonical:changed [${event.key}] flagged ${result.flagged} dream insight(s)`);
  }
  return result;
}

/** Drop this key's notes for a value that is current again; unflag when none remain. */
function clearInsightFlags(db: DatabaseSync, key: string, value: string): number {
  const rows = db
    .prepare(
      `SELECT id, stale_fact FROM dream_insights
        WHERE stale_fact IS NOT NULL AND stale_fact LIKE '%"superseded"%'
        ORDER BY rowid DESC LIMIT 2000`,
    )
    .all() as unknown as Array<{ id: string; stale_fact: string }>;
  const write = db.prepare(`UPDATE dream_insights SET stale_fact = ? WHERE id = ?`);
  const norm = normalizeExact(value);
  let n = 0;
  for (const row of rows) {
    const notes = parseInsightNotes(row.stale_fact);
    const kept = notes.filter(
      (x) => !(x.reason === "superseded" && x.key === key && normalizeExact(x.oldValue) === norm),
    );
    if (kept.length === notes.length) {
      continue;
    }
    write.run(kept.length > 0 ? JSON.stringify(kept) : null, row.id);
    if (kept.length === 0) {
      n++;
    }
  }
  return n;
}

/**
 * Why this insight must not be promoted, or null. Best-effort: a database
 * without the v78 columns or the audit table reads as "no block".
 */
export function insightPromotionBlock(
  db: DatabaseSync,
  insight: { id: string; sourceChunkIds: string[] },
): string | null {
  try {
    const row = db.prepare(`SELECT stale_fact FROM dream_insights WHERE id = ?`).get(insight.id) as
      | { stale_fact: string | null }
      | undefined;
    if (row?.stale_fact) {
      return "stale_fact";
    }
  } catch {
    return null;
  }
  const ids = insight.sourceChunkIds.slice(0, 50);
  if (ids.length === 0) {
    return null;
  }
  const placeholders = ids.map(() => "?").join(",");
  try {
    const marked = db
      .prepare(`SELECT 1 FROM chunk_supersessions WHERE chunk_id IN (${placeholders}) LIMIT 1`)
      .get(...ids);
    if (marked) {
      return "superseded_evidence";
    }
  } catch {
    // pre-v78 database
  }
  const forgotten = new Set<string>();
  try {
    for (const r of db
      .prepare(
        `SELECT chunk_id FROM memory_audit_log
          WHERE chunk_id IN (${placeholders}) AND event = 'owner_forget'`,
      )
      .all(...ids) as Array<{ chunk_id: string }>) {
      forgotten.add(r.chunk_id);
    }
  } catch {
    // no audit table
  }
  if (forgotten.size === 0) {
    return null;
  }
  try {
    const note: InsightStaleNote = {
      reason: "forgotten_evidence",
      chunkIds: [...forgotten],
      at: Date.now(),
    };
    db.prepare(`UPDATE dream_insights SET stale_fact = ? WHERE id = ? AND stale_fact IS NULL`).run(
      JSON.stringify([note]),
      insight.id,
    );
  } catch {
    // flagging is an optimisation; the block below still holds
  }
  return "forgotten_evidence";
}
