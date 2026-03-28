/**
 * Fact Conflict Resolver — Mem0-inspired ADD/UPDATE/NOOP resolution.
 *
 * Before storing an extracted fact, checks for contradictions with existing
 * chunks using embedding similarity. No additional LLM call required.
 *
 * Resolution logic:
 * - cosine > 0.95: NOOP (identical fact already exists, skip)
 * - cosine > 0.85: UPDATE (supersede old fact by setting valid_time_end)
 * - cosine <= 0.85: ADD (new fact, no conflict)
 *
 * When updating, the old chunk gets its valid_time_end set to now (bitemporal
 * supersession) rather than being deleted, preserving historical provenance.
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

export type ConflictAction = "add" | "update" | "noop";

export type ConflictResolution = {
  action: ConflictAction;
  existingChunkId?: string;
  similarity: number;
  reason: string;
};

const NOOP_THRESHOLD = 0.95;
const UPDATE_THRESHOLD = 0.85;
const MAX_CANDIDATES = 5;

/**
 * Resolve whether a new fact conflicts with existing chunks.
 *
 * @param factEmbedding  Embedding vector of the new fact
 * @param db             Database connection
 * @param providerModel  Embedding model identifier for filtering
 * @returns Resolution with recommended action
 */
export function resolveFactConflict(
  factEmbedding: number[],
  db: DatabaseSync,
  providerModel: string,
): ConflictResolution {
  if (factEmbedding.length === 0) {
    return { action: "add", similarity: 0, reason: "No embedding available" };
  }

  // Find the most similar existing chunks
  let candidates: Array<{ id: string; embedding: string }>;
  try {
    candidates = db
      .prepare(
        `SELECT id, embedding FROM chunks
         WHERE model = ?
           AND (COALESCE(lifecycle, 'generated') NOT IN ('expired', 'forgotten'))
           AND valid_time_end IS NULL
         LIMIT 500`,
      )
      .all(providerModel) as Array<{ id: string; embedding: string }>;
  } catch {
    return { action: "add", similarity: 0, reason: "Database query failed" };
  }

  if (candidates.length === 0) {
    return { action: "add", similarity: 0, reason: "No existing chunks to compare" };
  }

  // Score all candidates by cosine similarity
  const scored = candidates
    .map((c) => {
      const emb = parseEmbedding(c.embedding);
      if (emb.length === 0) return null;
      return { id: c.id, similarity: cosineSimilarity(factEmbedding, emb) };
    })
    .filter((c): c is { id: string; similarity: number } => c !== null && Number.isFinite(c.similarity))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES);

  if (scored.length === 0) {
    return { action: "add", similarity: 0, reason: "No valid embeddings found" };
  }

  const best = scored[0]!;

  // NOOP: near-identical fact already exists
  if (best.similarity >= NOOP_THRESHOLD) {
    return {
      action: "noop",
      existingChunkId: best.id,
      similarity: best.similarity,
      reason: `Near-identical fact exists (cosine ${best.similarity.toFixed(3)})`,
    };
  }

  // UPDATE: high similarity but different content — supersede the old fact
  if (best.similarity >= UPDATE_THRESHOLD) {
    return {
      action: "update",
      existingChunkId: best.id,
      similarity: best.similarity,
      reason: `Contradictory/updated fact detected (cosine ${best.similarity.toFixed(3)})`,
    };
  }

  // ADD: sufficiently different — new fact
  return {
    action: "add",
    similarity: best.similarity,
    reason: `New fact (max similarity ${best.similarity.toFixed(3)})`,
  };
}

/**
 * Apply the supersession: set valid_time_end on the old chunk.
 * Returns true if the update was applied.
 */
export function supersedeChunk(
  db: DatabaseSync,
  chunkId: string,
  nowMs?: number,
): boolean {
  const now = nowMs ?? Date.now();
  try {
    const result = db
      .prepare(
        `UPDATE chunks SET valid_time_end = ? WHERE id = ? AND valid_time_end IS NULL`,
      )
      .run(now, chunkId);
    return (result as { changes: number }).changes > 0;
  } catch {
    return false;
  }
}
