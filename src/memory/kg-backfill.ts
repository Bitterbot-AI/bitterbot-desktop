/**
 * PLAN-28 A3 — one-time general relationship backfill (deterministic).
 *
 * The graph/SABM layers are complete but dormant when `relationships` is empty:
 * thousands of "X works on Y" / "service hosted on AWS" facts live in
 * fact/insight/world_fact crystals that the relationship-typed hot path never
 * mined. This bounded pass runs the conservative A1 typed extractor over that
 * history so the graph populates immediately rather than waiting for the
 * go-forward path (and the offline A2 miner) to drain it.
 *
 * Kept as a standalone function (no LLM, no embeddings) so it is unit-testable
 * against a seeded in-memory DB without spinning up the full MemoryManager — the
 * same split the rest of the KG extraction layer uses.
 */

import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeGraphManager } from "./knowledge-graph.js";
import { extractTypedRelationshipFromFact } from "./kg-relationship-extract.js";

/**
 * Scan fact-like crystals and ingest a typed edge for each that yields one.
 * Bounded by `limit`; idempotent (upsert). Returns the number of edges created.
 */
export function backfillTypedRelationships(
  db: DatabaseSync,
  kg: KnowledgeGraphManager,
  opts: { limit?: number } = {},
): number {
  const limit = opts.limit ?? 2000;
  let created = 0;
  const rows = db
    .prepare(
      `SELECT id, text FROM chunks
       WHERE (COALESCE(semantic_type, 'general') IN ('fact', 'insight', 'preference', 'relationship', 'task_pattern')
              OR COALESCE(epistemic_layer, '') IN ('world_fact', 'mental_model', 'directive'))
         AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated', 'frozen')
         AND text IS NOT NULL AND length(text) > 0
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; text: string }>;
  for (const row of rows) {
    const edge = extractTypedRelationshipFromFact(row.text);
    if (!edge) {
      continue;
    }
    kg.ingestExtraction(
      [
        { name: edge.sourceName, type: edge.sourceType },
        { name: edge.targetName, type: edge.targetType },
      ],
      [edge],
      [row.id],
    );
    created += 1;
  }
  return created;
}
