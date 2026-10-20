/**
 * Semantic-embedding coverage check.
 *
 * PLAN-46 dead-code pass (2026-09-07): the per-perspective backfill
 * (procedural/causal/entity) and the multi-perspective search that read it were
 * removed as dead code (no runtime callers; the columns were NULL on every
 * row). Only the semantic (main `embedding`) coverage is meaningful — the
 * "unembedded crystal" blind spot doctor reports.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * Count live chunks missing a semantic (main) embedding. Blob-aware: an
 * embedding is present when the column is a non-trivial blob or JSON array.
 */
export function countMissingEmbeddings(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as c FROM chunks
           WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                  OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
             AND (embedding IS NULL OR length(embedding) < 8 OR embedding = '[]')`,
      )
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
