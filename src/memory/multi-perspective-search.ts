/**
 * Multi-Perspective Search: retrieves crystals using Reciprocal Rank Fusion (RRF)
 * across 4 embedding perspectives (semantic, procedural, causal, entity).
 */

import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingPerspective, MultiPerspectiveEmbedding } from "./crystal-types.js";
import type { EmbeddingProvider } from "./embedding-perspectives.js";
import { embedWithPerspectives } from "./embedding-perspectives.js";
import { cosineSimilarity, parseEmbedding } from "./internal.js";

export type PerspectiveWeights = {
  semantic: number;
  procedural: number;
  causal: number;
  entity: number;
};

export const WEIGHT_PROFILES: Record<string, PerspectiveWeights> = {
  general: { semantic: 0.7, procedural: 0.1, causal: 0.1, entity: 0.1 },
  skill_discovery: { semantic: 0.3, procedural: 0.3, causal: 0.1, entity: 0.3 },
  debugging: { semantic: 0.2, procedural: 0.1, causal: 0.5, entity: 0.2 },
  learning_path: { semantic: 0.1, procedural: 0.5, causal: 0.3, entity: 0.1 },
} as const;

export type ScoredCrystal = {
  id: string;
  text: string;
  score: number;
  perspectiveRanks: Record<EmbeddingPerspective, number>;
  perspectiveScores: Record<EmbeddingPerspective, number>;
};

type ChunkRow = {
  id: string;
  text: string;
  embedding: string;
  embedding_procedural: string | null;
  embedding_causal: string | null;
  embedding_entity: string | null;
  importance_score: number;
  steering_reward: number | null;
};

/**
 * Search using multi-perspective embeddings with RRF fusion.
 */
export async function multiPerspectiveSearch(
  query: string,
  weights: PerspectiveWeights,
  db: DatabaseSync,
  provider: EmbeddingProvider,
  limit = 20,
): Promise<ScoredCrystal[]> {
  // Embed query with all perspectives
  const queryEmbeddings = await embedWithPerspectives(query, provider);

  return multiPerspectiveSearchWithEmbeddings(queryEmbeddings, weights, db, limit);
}

/**
 * Search with pre-computed query embeddings (avoids re-embedding).
 */
export function multiPerspectiveSearchWithEmbeddings(
  queryEmbeddings: MultiPerspectiveEmbedding,
  weights: PerspectiveWeights,
  db: DatabaseSync,
  limit = 20,
): ScoredCrystal[] {
  // Load all active chunks with embeddings
  const chunks = db
    .prepare(
      `SELECT id, text, embedding, embedding_procedural, embedding_causal,
              embedding_entity, importance_score, steering_reward
       FROM chunks
       WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
              OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
         AND COALESCE(deprecated, 0) = 0
       LIMIT 1000`,
    )
    .all() as ChunkRow[];

  if (chunks.length === 0) return [];

  const perspectives: EmbeddingPerspective[] = ["semantic", "procedural", "causal", "entity"];

  // For each perspective, compute similarity and rank
  const perspectiveRankings = new Map<
    EmbeddingPerspective,
    Map<string, { rank: number; sim: number }>
  >();

  for (const perspective of perspectives) {
    if (weights[perspective] === 0) continue;

    const queryEmb = queryEmbeddings[perspective];
    if (queryEmb.length === 0) continue;

    const scored: Array<{ id: string; sim: number }> = [];
    for (const chunk of chunks) {
      const embCol =
        perspective === "semantic"
          ? chunk.embedding
          : perspective === "procedural"
            ? chunk.embedding_procedural
            : perspective === "causal"
              ? chunk.embedding_causal
              : chunk.embedding_entity;

      if (!embCol) continue;
      const emb = parseEmbedding(embCol);
      if (emb.length === 0) continue;

      scored.push({ id: chunk.id, sim: cosineSimilarity(queryEmb, emb) });
    }

    // Sort by similarity descending
    scored.sort((a, b) => b.sim - a.sim);

    const rankMap = new Map<string, { rank: number; sim: number }>();
    for (let i = 0; i < scored.length; i++) {
      rankMap.set(scored[i]!.id, { rank: i + 1, sim: scored[i]!.sim });
    }
    perspectiveRankings.set(perspective, rankMap);
  }

  // RRF fusion: score(d) = Σ(weight_i / (rank_i + 60))
  const RRF_K = 60;
  const chunkTextMap = new Map<string, string>();
  const importanceMap = new Map<string, number>();
  const steeringMap = new Map<string, number>();
  for (const chunk of chunks) {
    chunkTextMap.set(chunk.id, chunk.text);
    importanceMap.set(chunk.id, chunk.importance_score);
    steeringMap.set(chunk.id, chunk.steering_reward ?? 0);
  }

  const fusedScores = new Map<
    string,
    {
      score: number;
      ranks: Record<EmbeddingPerspective, number>;
      sims: Record<EmbeddingPerspective, number>;
    }
  >();

  const allIds = new Set(chunks.map((c) => c.id));
  for (const id of allIds) {
    let score = 0;
    const ranks = { semantic: 0, procedural: 0, causal: 0, entity: 0 };
    const sims = { semantic: 0, procedural: 0, causal: 0, entity: 0 };

    for (const perspective of perspectives) {
      const w = weights[perspective];
      if (w === 0) continue;

      const ranking = perspectiveRankings.get(perspective);
      if (!ranking) continue;

      const entry = ranking.get(id);
      if (entry) {
        score += w / (entry.rank + RRF_K);
        ranks[perspective] = entry.rank;
        sims[perspective] = entry.sim;
      }
    }

    // Apply steering reward boost only. Importance is decoupled from retrieval
    // ranking — it now governs memory lifecycle (consolidation/forgetting) exclusively.
    const steering = steeringMap.get(id) ?? 0;
    score *= 1 + steering * 0.2;

    fusedScores.set(id, { score, ranks, sims });
  }

  // Sort by fused score and return top-K
  const results = [...fusedScores.entries()]
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([id, { score, ranks, sims }]) => ({
      id,
      text: chunkTextMap.get(id) ?? "",
      score,
      perspectiveRanks: ranks,
      perspectiveScores: sims,
    }));

  return results;
}
