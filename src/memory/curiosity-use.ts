/**
 * PLAN-54: the use ledger for self-learned facts.
 *
 * "Did curiosity make the agent smarter?" needs a number. Every chunk the
 * agent learned on its own is a row in `curiosity_findings`; when memory
 * search or proactive recall surfaces that chunk in a conversation, the row
 * records the first use and counts later ones. Per-region ROI (used / learned)
 * feeds back into which questions get researched next, so the agent learns
 * where learning pays off. No cited memory system closes this loop.
 */

import type { DatabaseSync } from "node:sqlite";

/** Chunk ids that came from curiosity research, out of the given set. */
export function curiosityChunkIds(db: DatabaseSync, chunkIds: string[]): string[] {
  if (chunkIds.length === 0) {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT chunk_id FROM curiosity_findings
          WHERE chunk_id IN (${chunkIds.map(() => "?").join(",")})`,
      )
      .all(...chunkIds) as unknown as Array<{ chunk_id: string }>;
    return rows.map((r) => r.chunk_id);
  } catch {
    return [];
  }
}

/** Count a conversation's use of self-learned chunks. Returns how many rows were touched. */
export function recordCuriosityUse(
  db: DatabaseSync,
  chunkIds: string[],
  now: number = Date.now(),
): number {
  const ids = curiosityChunkIds(db, chunkIds);
  if (ids.length === 0) {
    return 0;
  }
  try {
    const res = db
      .prepare(
        `UPDATE curiosity_findings
            SET used_count = used_count + 1,
                first_used_at = COALESCE(first_used_at, ?)
          WHERE chunk_id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(now, ...ids);
    return Number(res.changes);
  } catch {
    return 0;
  }
}

/**
 * A finding the agent voiced ("while you were away, I looked into X") was
 * used, whether or not retrieval also returned its chunk. Keyed by target.
 */
export function recordCuriosityUseByTarget(
  db: DatabaseSync,
  targetIds: string[],
  now: number = Date.now(),
): number {
  if (targetIds.length === 0) {
    return 0;
  }
  try {
    const res = db
      .prepare(
        `UPDATE curiosity_findings
            SET used_count = used_count + 1,
                first_used_at = COALESCE(first_used_at, ?)
          WHERE COALESCE(verified, 1) = 1
            AND target_id IN (${targetIds.map(() => "?").join(",")})`,
      )
      .run(now, ...targetIds);
    return Number(res.changes);
  } catch {
    return 0;
  }
}

/** Share of self-learned facts per region that a conversation went on to use. */
export function curiosityRoiByRegion(db: DatabaseSync): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT region_id, COUNT(*) AS n, SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) AS used
           FROM curiosity_findings WHERE region_id IS NOT NULL AND COALESCE(verified, 1) = 1
          GROUP BY region_id`,
      )
      .all() as unknown as Array<{ region_id: string; n: number; used: number }>;
    for (const r of rows) {
      out.set(r.region_id, r.n > 0 ? r.used / r.n : 0);
    }
  } catch {
    // table absent on a pre-v73 database
  }
  return out;
}

export type CuriosityUtility = {
  learned: number;
  used: number;
  /** used / learned, 0 when nothing learned yet. */
  roi: number;
  costUsd: number;
};

export function curiosityUtility(db: DatabaseSync, sinceMs = 0): CuriosityUtility {
  try {
    const r = db
      .prepare(
        `SELECT SUM(CASE WHEN COALESCE(verified, 1) = 1 THEN 1 ELSE 0 END) AS n,
                SUM(CASE WHEN used_count > 0 THEN 1 ELSE 0 END) AS used,
                COALESCE(SUM(cost_usd), 0) AS cost
           FROM curiosity_findings WHERE created_at >= ?`,
      )
      .get(sinceMs) as { n: number | null; used: number | null; cost: number };
    const used = r.used ?? 0;
    const n = r.n ?? 0;
    return { learned: n, used, roi: n > 0 ? used / n : 0, costUsd: r.cost };
  } catch {
    return { learned: 0, used: 0, roi: 0, costUsd: 0 };
  }
}
