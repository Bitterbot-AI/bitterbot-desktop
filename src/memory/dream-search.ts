/**
 * Dream search: query dream insights by embedding similarity.
 *
 * PLAN-34 Phase 4: promoted insights now live in `chunks` (origin='dream'
 * AND semantic_type='insight'), so dream_search reads there — the promoted,
 * gated, retrievable corpus — with a fallback to legacy dream_insights rows
 * for content that predates promotion (kept read-only as history).
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

export type DreamSearchResult = {
  id: string;
  content: string;
  confidence: number;
  mode: string;
  score: number;
  importanceScore: number;
  sourceChunkIds: string[];
  dreamCycleId: string;
  createdAt: number;
};

type InsightRow = {
  id: string;
  content: string;
  embedding: string;
  confidence: number;
  mode: string;
  source_chunk_ids: string;
  dream_cycle_id: string;
  importance_score: number;
  access_count: number;
  created_at: number;
};

export function searchDreamInsights(
  db: DatabaseSync,
  queryEmbedding: number[],
  opts?: { maxResults?: number; minScore?: number },
): DreamSearchResult[] {
  const maxResults = opts?.maxResults ?? 10;
  const minScore = opts?.minScore ?? 0.3;

  const scored: DreamSearchResult[] = [];

  // PLAN-34 Phase 4: promoted dream insights, as chunks.
  const chunkRows = db
    .prepare(
      `SELECT id, text AS content, embedding, importance_score, created_at
       FROM chunks
       WHERE origin = 'dream' AND semantic_type = 'insight'
       ORDER BY importance_score DESC LIMIT 200`,
    )
    .all() as Array<{
    id: string;
    content: string;
    embedding: string;
    importance_score: number;
    created_at: number;
  }>;
  for (const row of chunkRows) {
    const emb = parseEmbedding(row.embedding);
    if (emb.length === 0) {
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score < minScore) {
      continue;
    }
    scored.push({
      id: row.id,
      content: row.content,
      confidence: Math.min(1, Math.max(0, row.importance_score / 0.5)),
      mode: "insight",
      score,
      importanceScore: row.importance_score,
      sourceChunkIds: [],
      dreamCycleId: "",
      createdAt: row.created_at,
    });
  }

  // Legacy dream_insights history (read-only) — content that predates
  // promotion still answers dream_search.
  const rows = db
    .prepare(
      `SELECT id, content, embedding, confidence, mode, source_chunk_ids, dream_cycle_id, importance_score, access_count, created_at FROM dream_insights ORDER BY importance_score DESC LIMIT 200`,
    )
    .all() as InsightRow[];
  for (const row of rows) {
    const emb = parseEmbedding(row.embedding);
    if (emb.length === 0) {
      continue;
    }
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score < minScore) {
      continue;
    }
    let sourceChunkIds: string[] = [];
    try {
      sourceChunkIds = JSON.parse(row.source_chunk_ids);
    } catch {}
    scored.push({
      id: row.id,
      content: row.content,
      confidence: row.confidence,
      mode: row.mode,
      score,
      importanceScore: row.importance_score,
      sourceChunkIds,
      dreamCycleId: row.dream_cycle_id,
      createdAt: row.created_at,
    });
  }

  // Update access tracking for returned legacy rows (chunk access is tracked
  // by the normal retrieval path).
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);
  const legacyIds = new Set(rows.map((r) => r.id));
  const now = Date.now();
  try {
    const stmt = db.prepare(
      `UPDATE dream_insights SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
    );
    for (const result of top) {
      if (legacyIds.has(result.id)) {
        stmt.run(now, result.id);
      }
    }
  } catch {
    // Non-critical
  }

  return top;
}
