/**
 * BioMemEval test helpers: deterministic embeddings and chunk insertion.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

/** Seeded PRNG for deterministic embeddings. */
function xorshift32(seed: number): () => number {
  let state = seed | 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Generate a deterministic embedding from a seed string. */
export function deterministicEmbedding(seed: string, dim = 50): number[] {
  const rng = xorshift32(hashString(seed));
  const emb = Array.from({ length: dim }, () => rng() * 2 - 1);
  const norm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? emb.map((v) => v / norm) : emb;
}

/** Generate an embedding with target cosine similarity to a base. */
export function similarEmbedding(base: number[], similarity: number): number[] {
  const dim = base.length;
  const ortho = deterministicEmbedding("ortho-" + base[0]?.toFixed(4), dim);
  const mixed = base.map((v, i) => similarity * v + (1 - similarity) * (ortho[i] ?? 0));
  const norm = Math.sqrt(mixed.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? mixed.map((v) => v / norm) : mixed;
}

/** Generate an embedding orthogonal (low similarity) to the base. */
export function orthogonalEmbedding(base: number[]): number[] {
  return similarEmbedding(base, 0.1);
}

export type ChunkOverrides = Partial<{
  id: string;
  path: string;
  text: string;
  embedding: number[];
  importance_score: number;
  access_count: number;
  last_accessed_at: number | null;
  emotional_valence: number | null;
  semantic_type: string;
  lifecycle: string;
  dream_count: number;
  created_at: number;
  updated_at: number;
  steering_reward: number;
  hormonal_dopamine: number;
  hormonal_cortisol: number;
  hormonal_oxytocin: number;
  open_loop: number;
  open_loop_context: string | null;
  labile_until: number | null;
  reconsolidation_count: number;
  captured_by: string | null;
  access_timestamps: string;
  spacing_score: number;
}>;

/** Insert a chunk into the benchmark database. Returns the chunk ID. */
export function insertChunk(db: DatabaseSync, overrides: ChunkOverrides = {}): string {
  const id = overrides.id ?? crypto.randomUUID();
  const embedding = overrides.embedding ?? deterministicEmbedding(id);
  const now = Date.now();

  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, hash, model, text, embedding,
      updated_at, importance_score, access_count, last_accessed_at,
      emotional_valence, semantic_type, lifecycle, dream_count, created_at,
      steering_reward, hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin,
      open_loop, open_loop_context, labile_until, reconsolidation_count,
      captured_by, access_timestamps, spacing_score
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )`,
  ).run(
    id,
    overrides.path ?? "test.md",
    "memory",
    0,
    10,
    "hash-" + id.slice(0, 8),
    "test-model",
    overrides.text ?? `Test chunk ${id.slice(0, 8)}`,
    JSON.stringify(embedding),
    overrides.updated_at ?? now,
    overrides.importance_score ?? 0.5,
    overrides.access_count ?? 0,
    overrides.last_accessed_at ?? null,
    overrides.emotional_valence ?? null,
    overrides.semantic_type ?? "general",
    overrides.lifecycle ?? "generated",
    overrides.dream_count ?? 0,
    overrides.created_at ?? now,
    overrides.steering_reward ?? 0,
    overrides.hormonal_dopamine ?? 0,
    overrides.hormonal_cortisol ?? 0,
    overrides.hormonal_oxytocin ?? 0,
    overrides.open_loop ?? 0,
    overrides.open_loop_context ?? null,
    overrides.labile_until ?? null,
    overrides.reconsolidation_count ?? 0,
    overrides.captured_by ?? null,
    overrides.access_timestamps ?? "[]",
    overrides.spacing_score ?? 0,
  );

  return id;
}

/** Time helpers for temporal tests. */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;

export function daysAgo(n: number): number {
  return Date.now() - n * ONE_DAY_MS;
}

export function hoursAgo(n: number): number {
  return Date.now() - n * ONE_HOUR_MS;
}
