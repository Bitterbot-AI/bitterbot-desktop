/**
 * ConsolidationEngine: scores all chunks, merges semantically overlapping
 * promoted chunks into super-chunks, and soft-deletes decayed chunks.
 *
 * MemCube lifecycle: uses lifecycle_state transitions instead of hard DELETE.
 * Forgotten chunks get lifecycle_state='forgotten'. Merged chunks get parent_id
 * set to the surviving chunk. Skill-type chunks are immune to decay.
 * All state transitions are logged to memory_audit_log.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { calculateImportance, shouldForget } from "./importance.js";
import { cosineSimilarity, computeCentroid, parseEmbedding } from "./internal.js";
import { recordDreamTelemetry } from "./dream-schema.js";

const log = createSubsystemLogger("memory/consolidation");

export type ConsolidationConfig = {
  decayRate: number;
  promoteThreshold: number;
  forgetThreshold: number;
  mergeOverlapThreshold: number;
  emotionDecayResistance: number;
};

export type ConsolidationStats = {
  totalChunks: number;
  scoredChunks: number;
  mergedChunks: number;
  forgottenChunks: number;
  durationMs: number;
};

type ChunkRow = {
  id: string;
  path: string;
  source: string;
  start_line: number;
  end_line: number;
  hash: string;
  model: string;
  text: string;
  embedding: string;
  updated_at: number;
  importance_score: number;
  access_count: number;
  last_accessed_at: number;
  memory_type: string | null;
  emotional_valence: number | null;
  semantic_type: string | null;
  lifecycle_state: string | null;
  lifecycle: string | null;
};

// Base relevance by semantic type: structurally important content gets a survival
// advantage in consolidation without the compounding decay problem.
const SEMANTIC_TYPE_RELEVANCE: Record<string, number> = {
  preference: 1.2,
  goal: 1.2,
  task_pattern: 1.1,
  insight: 1.1,
  relationship: 1.1,
  skill: 1.0,
  fact: 1.0,
  episode: 0.8,
  general: 0.8,
};

// SNN near-merge candidate type (Plan 6, Phase 3)
export interface NearMergeCandidate {
  chunkIdA: string;
  chunkIdB: string;
  baseSimilarity: number;
  sharedNeighbors: number;
  snnSimilarity: number;
}

// Anti-catastrophic forgetting: orphan cluster type (Plan 6, Phase 7)
export interface OrphanCluster {
  chunkIds: string[];
  centroid: number[];
  avgImportance: number;
  avgAgeDays: number;
  semanticTypes: string[];
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  decayRate: 0.0000000005,
  promoteThreshold: 0.7,
  forgetThreshold: 0.02,
  mergeOverlapThreshold: 0.92,
  emotionDecayResistance: 0.5,
};

export class ConsolidationEngine {
  private readonly db: DatabaseSync;
  private readonly config: ConsolidationConfig;

  constructor(db: DatabaseSync, config?: Partial<ConsolidationConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  run(): ConsolidationStats {
    const start = Date.now();
    const stats: ConsolidationStats = {
      totalChunks: 0,
      scoredChunks: 0,
      mergedChunks: 0,
      forgottenChunks: 0,
      durationMs: 0,
    };

    const chunks = this.db
      .prepare(
        `SELECT id, path, source, start_line, end_line, hash, model, text, embedding,
                updated_at, importance_score, access_count, last_accessed_at,
                memory_type, emotional_valence, semantic_type, lifecycle_state, lifecycle
         FROM chunks
         WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
                OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
           AND COALESCE(lifecycle, '') != 'frozen'`,
      )
      .all() as ChunkRow[];

    stats.totalChunks = chunks.length;
    if (chunks.length === 0) {
      stats.durationMs = Date.now() - start;
      return stats;
    }

    // Phase 1: Score all chunks (skill-type chunks are immune to decay)
    const scored = this.scoreChunks(chunks);
    stats.scoredChunks = scored.length;

    // Phase 2: Identify chunks to forget (skip skill-type chunks)
    const toForget: string[] = [];
    const surviving: Array<{ chunk: ChunkRow; newScore: number }> = [];
    for (const entry of scored) {
      const isSkill = (entry.chunk.memory_type ?? "plaintext") === "skill";
      if (!isSkill && shouldForget(entry.newScore, this.config.forgetThreshold)) {
        toForget.push(entry.chunk.id);
      } else {
        surviving.push(entry);
      }
    }

    // Phase 3: Merge semantically overlapping promoted chunks
    const mergePairs = this.findMergeCandidatesWithParent(surviving);
    stats.mergedChunks = mergePairs.length;

    // Phase 3b: SNN near-merge discovery (Plan 6, Phase 3)
    // Finds chunk pairs in the near-miss cosine zone that share enough nearest neighbors
    try {
      const snnChunks = surviving.map(p => {
        const emb = this.parseEmbedding(p.chunk.embedding);
        return emb ? { id: p.chunk.id, embedding: emb, path: p.chunk.path } : null;
      }).filter((c): c is { id: string; embedding: number[]; path: string } => c !== null);

      if (snnChunks.length > 10) {
        const nearMerges = this.discoverNearMerges(snnChunks);
        if (nearMerges.length > 0) {
          const hintStmt = this.db.prepare(
            `INSERT OR REPLACE INTO near_merge_hints
             (chunk_id_a, chunk_id_b, base_similarity, snn_similarity, shared_neighbors, discovered_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          );
          const discoveredAt = Date.now();
          for (const c of nearMerges) {
            hintStmt.run(c.chunkIdA, c.chunkIdB, c.baseSimilarity, c.snnSimilarity, c.sharedNeighbors, discoveredAt);
          }
          log.debug("SNN near-merge candidates discovered", { count: nearMerges.length });
          recordDreamTelemetry(this.db, `consolidation-${discoveredAt}`, "snn_merge", "candidates_found", nearMerges.length);
        }
      }
    } catch (err) {
      log.debug(`SNN merge discovery skipped: ${String(err)}`);
    }

    // Phase 4: Apply changes in a transaction
    const now = Date.now();
    try {
      this.db.exec("BEGIN");

      // Update importance scores
      const updateStmt = this.db.prepare(
        `UPDATE chunks SET importance_score = ? WHERE id = ?`,
      );
      for (const entry of scored) {
        updateStmt.run(entry.newScore, entry.chunk.id);
      }

      // Soft-delete: set lifecycle='expired' (and legacy lifecycle_state='forgotten')
      const forgetStmt = this.db.prepare(
        `UPDATE chunks SET lifecycle_state = 'forgotten', lifecycle = 'expired', version = COALESCE(version, 1) + 1 WHERE id = ?`,
      );
      const auditStmt = this.db.prepare(
        `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const id of toForget) {
        forgetStmt.run(id);
        auditStmt.run(crypto.randomUUID(), id, "forgotten", now, "consolidation", "{}");
      }
      stats.forgottenChunks = toForget.length;

      // Merge: winner gets 'consolidated', loser gets 'archived' with parent_id
      const mergeStmt = this.db.prepare(
        `UPDATE chunks SET lifecycle_state = 'forgotten', lifecycle = 'archived', parent_id = ?, version = COALESCE(version, 1) + 1 WHERE id = ?`,
      );
      const promoteWinnerStmt = this.db.prepare(
        `UPDATE chunks SET lifecycle = 'consolidated', last_consolidated_at = ? WHERE id = ?`,
      );
      for (const { loserId, winnerId } of mergePairs) {
        mergeStmt.run(winnerId, loserId);
        promoteWinnerStmt.run(now, winnerId);
        auditStmt.run(
          crypto.randomUUID(), loserId, "merged", now, "consolidation",
          JSON.stringify({ parent_id: winnerId }),
        );
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      log.warn(`consolidation transaction failed: ${String(err)}`);
      throw err;
    }

    // Phase 5: Decay steering rewards to prevent unbounded accumulation
    this.decaySteeringRewards();

    // Phase 6: Anti-catastrophic forgetting — queue orphan clusters for replay
    const orphansQueued = this.rescueOrphanClusters();
    if (orphansQueued > 0) {
      log.info(`anti-forgetting: queued ${orphansQueued} chunks from orphan clusters for replay`);
      recordDreamTelemetry(this.db, `consolidation-${Date.now()}`, "orphan_rescue", "chunks_queued", orphansQueued);
    }

    stats.durationMs = Date.now() - start;
    log.debug("consolidation complete", stats);
    return stats;
  }

  /**
   * Decay steering rewards on all chunks (Phase 3).
   * Called during consolidation to prevent unbounded reward accumulation.
   */
  decaySteeringRewards(factor = 0.95): number {
    try {
      const result = this.db
        .prepare(
          `UPDATE chunks SET steering_reward = steering_reward * ?
           WHERE COALESCE(steering_reward, 0) != 0`,
        )
        .run(factor);
      return (result as { changes: number }).changes;
    } catch (err) {
      log.warn(`decaySteeringRewards failed: ${String(err)}`);
      return 0;
    }
  }

  // ── Anti-Catastrophic Forgetting (Plan 6, Phase 7) ──

  /**
   * Detect orphan clusters: important but neglected memory groups.
   *
   * Criteria:
   * - importance_score > 0.4 (not trivial)
   * - last_accessed_at > 7 days ago (neglected)
   * - Not archived/expired
   * - Cluster together (cosine > 0.75) forming a coherent topic
   */
  detectOrphanClusters(maxClusters: number = 5): Array<{ chunkIds: string[]; centroid: number[]; avgImportance: number; avgAgeDays: number; semanticTypes: string[] }> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

    let neglected: Array<ChunkRow & { semantic_type: string }>;
    try {
      neglected = this.db.prepare(
        `SELECT id, path, source, start_line, end_line, hash, model, text, embedding,
                updated_at, importance_score, access_count, last_accessed_at,
                memory_type, emotional_valence, lifecycle_state, lifecycle,
                COALESCE(semantic_type, 'general') as semantic_type
         FROM chunks
         WHERE importance_score > 0.4
           AND (last_accessed_at IS NULL OR last_accessed_at < ?)
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'consolidated')
         ORDER BY importance_score DESC
         LIMIT 100`,
      ).all(cutoff) as Array<ChunkRow & { semantic_type: string }>;
    } catch {
      return [];
    }

    if (neglected.length < 3) return [];

    const embeddings = neglected.map(r => parseEmbedding(r.embedding));
    const assigned = new Set<number>();
    const clusters: Array<{ chunkIds: string[]; centroid: number[]; avgImportance: number; avgAgeDays: number; semanticTypes: string[] }> = [];

    // Greedy single-linkage clustering
    for (let i = 0; i < neglected.length && clusters.length < maxClusters; i++) {
      if (assigned.has(i)) continue;
      if (embeddings[i]!.length === 0) continue;

      const cluster: number[] = [i];
      assigned.add(i);

      for (let j = i + 1; j < neglected.length; j++) {
        if (assigned.has(j)) continue;
        if (embeddings[j]!.length === 0) continue;
        if (cosineSimilarity(embeddings[i]!, embeddings[j]!) > 0.75) {
          cluster.push(j);
          assigned.add(j);
        }
      }

      if (cluster.length >= 2) {
        const clusterChunks = cluster.map(idx => neglected[idx]!);
        const now = Date.now();
        clusters.push({
          chunkIds: clusterChunks.map(c => c.id),
          centroid: computeCentroid(cluster.filter(idx => embeddings[idx]!.length > 0).map(idx => embeddings[idx]!)),
          avgImportance: clusterChunks.reduce((s, c) => s + c.importance_score, 0) / clusterChunks.length,
          avgAgeDays: clusterChunks.reduce((s, c) => s + (now - (c.last_accessed_at ?? 0)), 0) / clusterChunks.length / (24 * 60 * 60 * 1000),
          semanticTypes: [...new Set(clusterChunks.map(c => c.semantic_type))],
        });
      }
    }

    return clusters;
  }

  /**
   * Queue orphan clusters for replay via the dream engine.
   * Does NOT boost importance directly — lets the ripple-enhanced replay
   * pipeline handle consolidation properly.
   */
  rescueOrphanClusters(): number {
    const orphans = this.detectOrphanClusters();
    if (orphans.length === 0) return 0;

    let queued = 0;
    try {
      const queueStmt = this.db.prepare(
        `INSERT OR IGNORE INTO orphan_replay_queue (chunk_id, cluster_importance, cluster_size, queued_at)
         VALUES (?, ?, ?, ?)`,
      );
      const now = Date.now();

      for (const cluster of orphans) {
        for (const id of cluster.chunkIds) {
          queueStmt.run(id, cluster.avgImportance, cluster.chunkIds.length, now);
          queued++;
        }
        log.debug("queued orphan cluster for replay", {
          size: cluster.chunkIds.length,
          avgImportance: cluster.avgImportance.toFixed(2),
          avgAgeDays: cluster.avgAgeDays.toFixed(1),
          types: cluster.semanticTypes,
        });
      }
    } catch (err) {
      log.warn(`rescueOrphanClusters failed: ${String(err)}`);
      return 0;
    }

    return queued;
  }

  // ── SNN Merge Discovery (Plan 6, Phase 3) ──

  /**
   * Shared Nearest Neighbor merge discovery.
   * Finds chunk pairs in the near-miss zone (cosine 0.82-0.91) that share
   * enough nearest neighbors to suggest they belong to the same semantic cluster.
   *
   * These candidates are NOT auto-merged — they're stored as hints for
   * compression mode to evaluate via LLM-based or heuristic semantic comparison.
   *
   * @param k - Neighborhood size (default: 10)
   * @param minShared - Minimum shared neighbors to qualify (default: 4)
   */
  discoverNearMerges(
    chunks: Array<{ id: string; embedding: number[]; path?: string }>,
    k: number = 10,
    minShared: number = 4,
  ): NearMergeCandidate[] {
    if (chunks.length < k + 1) return [];

    const nearMissFloor = 0.82;
    const nearMissCeiling = this.config.mergeOverlapThreshold; // 0.92

    // Step 1: Compute pairwise cosine (cached) and k-NN for each chunk
    const pairwiseSim = new Map<string, number>();
    const knnSets = new Map<number, Set<number>>();

    for (let i = 0; i < chunks.length; i++) {
      const distances: Array<{ idx: number; sim: number }> = [];
      for (let j = 0; j < chunks.length; j++) {
        if (i === j) continue;
        const key = i < j ? `${i}:${j}` : `${j}:${i}`;
        let sim = pairwiseSim.get(key);
        if (sim === undefined) {
          sim = cosineSimilarity(chunks[i]!.embedding, chunks[j]!.embedding);
          pairwiseSim.set(key, sim);
        }
        distances.push({ idx: j, sim });
      }
      distances.sort((a, b) => b.sim - a.sim);
      knnSets.set(i, new Set(distances.slice(0, k).map(d => d.idx)));
    }

    // Step 2: For near-miss pairs, count shared neighbors
    const candidates: NearMergeCandidate[] = [];

    for (let i = 0; i < chunks.length; i++) {
      for (let j = i + 1; j < chunks.length; j++) {
        // Same-path constraint (existing merge behavior)
        if (chunks[i]!.path && chunks[j]!.path && chunks[i]!.path !== chunks[j]!.path) continue;

        const key = `${i}:${j}`;
        const baseSim = pairwiseSim.get(key) ?? 0;
        if (baseSim < nearMissFloor || baseSim >= nearMissCeiling) continue;

        // Count shared k-NN members
        const knnA = knnSets.get(i)!;
        const knnB = knnSets.get(j)!;
        let shared = 0;
        for (const neighbor of knnA) {
          if (knnB.has(neighbor)) shared++;
        }

        if (shared >= minShared) {
          candidates.push({
            chunkIdA: chunks[i]!.id,
            chunkIdB: chunks[j]!.id,
            baseSimilarity: baseSim,
            sharedNeighbors: shared,
            snnSimilarity: shared / k,
          });
        }
      }
    }

    candidates.sort((a, b) => b.snnSimilarity - a.snnSimilarity);
    return candidates;
  }

  /**
   * Physically delete forgotten chunks older than retentionMs.
   */
  purgeExpired(retentionMs: number): number {
    const cutoff = Date.now() - retentionMs;
    try {
      this.db.exec("BEGIN");
      // Delete vec/fts first (subqueries reference chunks which haven't been deleted yet)
      const deleteVecStmt = this.tryPrepare(
        `DELETE FROM chunks_vec WHERE id IN (SELECT id FROM chunks WHERE (lifecycle_state = 'forgotten' OR lifecycle = 'expired') AND updated_at < ?)`,
      );
      const deleteFtsStmt = this.tryPrepare(
        `DELETE FROM chunks_fts WHERE id IN (SELECT id FROM chunks WHERE (lifecycle_state = 'forgotten' OR lifecycle = 'expired') AND updated_at < ?)`,
      );
      deleteVecStmt?.run(cutoff);
      deleteFtsStmt?.run(cutoff);
      const result = this.db.prepare(
        `DELETE FROM chunks WHERE (lifecycle_state = 'forgotten' OR lifecycle = 'expired') AND updated_at < ?`,
      ).run(cutoff);
      this.db.exec("COMMIT");
      return (result as { changes: number }).changes;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      log.warn(`purgeExpired failed: ${String(err)}`);
      return 0;
    }
  }

  private scoreChunks(
    chunks: ChunkRow[],
  ): Array<{ chunk: ChunkRow; newScore: number }> {
    return chunks.map((chunk) => {
      // Use semantic-type-aware base relevance so that structurally important
      // content (preferences, goals) gets a survival advantage over boilerplate.
      // This is stateless — no compounding decay — since the relevance comes
      // from the chunk's semantic type, not its previous importance score.
      const semanticRelevance = SEMANTIC_TYPE_RELEVANCE[chunk.semantic_type ?? "general"] ?? 1.0;
      const newScore = calculateImportance(
        {
          semanticRelevance,
          accessCount: chunk.access_count ?? 0,
          createdAt: chunk.updated_at,
          lastAccessedAt: chunk.last_accessed_at ?? chunk.updated_at,
          emotionalValence: chunk.emotional_valence,
        },
        this.config.decayRate,
        this.config.emotionDecayResistance,
      );
      return { chunk, newScore };
    });
  }

  private findMergeCandidatesWithParent(
    entries: Array<{ chunk: ChunkRow; newScore: number }>,
  ): Array<{ loserId: string; winnerId: string }> {
    const promoted = entries.filter(
      (e) => e.newScore >= this.config.promoteThreshold,
    );
    if (promoted.length < 2) {
      return [];
    }

    const pairs: Array<{ loserId: string; winnerId: string }> = [];
    const merged = new Set<string>();

    for (let i = 0; i < promoted.length; i++) {
      if (merged.has(promoted[i].chunk.id)) {
        continue;
      }
      const embA = this.parseEmbedding(promoted[i].chunk.embedding);
      if (!embA) {
        continue;
      }

      for (let j = i + 1; j < promoted.length; j++) {
        if (merged.has(promoted[j].chunk.id)) {
          continue;
        }
        // Only merge chunks from the same path
        if (promoted[i].chunk.path !== promoted[j].chunk.path) {
          continue;
        }
        const embB = this.parseEmbedding(promoted[j].chunk.embedding);
        if (!embB) {
          continue;
        }
        const similarity = cosineSimilarity(embA, embB);
        if (similarity >= this.config.mergeOverlapThreshold) {
          // Keep the chunk with higher importance, remove the other
          if (promoted[i].newScore >= promoted[j].newScore) {
            pairs.push({ loserId: promoted[j].chunk.id, winnerId: promoted[i].chunk.id });
            merged.add(promoted[j].chunk.id);
          } else {
            pairs.push({ loserId: promoted[i].chunk.id, winnerId: promoted[j].chunk.id });
            merged.add(promoted[i].chunk.id);
            break;
          }
        }
      }
    }

    return pairs;
  }

  private parseEmbedding(raw: string): number[] | null {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as number[];
      }
      return null;
    } catch {
      return null;
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  private tryPrepare(sql: string): { run: (...args: any[]) => void } | null {
    try {
      return this.db.prepare(sql);
    } catch {
      return null;
    }
  }
}

