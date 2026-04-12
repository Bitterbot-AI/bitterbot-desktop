/**
 * Dream search: query dream insights by embedding similarity.
 */

import type { DatabaseSync } from "node:sqlite";
import type { DreamInsight, DreamMode } from "./dream-types.js";
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

  const rows = db
    .prepare(
      `SELECT id, content, embedding, confidence, mode, source_chunk_ids, dream_cycle_id, importance_score, access_count, created_at FROM dream_insights ORDER BY importance_score DESC LIMIT 200`,
    )
    .all() as InsightRow[];

  const scored: DreamSearchResult[] = [];
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

  // Update access tracking for returned results
  if (scored.length > 0) {
    const now = Date.now();
    try {
      const stmt = db.prepare(
        `UPDATE dream_insights SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      );
      for (const result of scored.slice(0, maxResults)) {
        stmt.run(now, result.id);
      }
    } catch {
      // Non-critical
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults);
}
