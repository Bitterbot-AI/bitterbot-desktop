/**
 * Synaptic Tagging & Capture: when a strong memory event occurs,
 * temporally-nearby weak memories get "captured" and consolidated
 * alongside the strong one.
 *
 * In biology, a strong stimulus induces plasticity-related proteins that
 * can be "captured" by weakly-tagged synapses within a ~2 hour window,
 * converting them from short-term to long-term memories.
 *
 * FIRST IMPLEMENTATION in any agent memory system.
 *
 * Scientific basis:
 * - Frey, U. & Morris, R.G. (1997). Synaptic tagging and LTP. Nature, 385.
 * - Moncada, D. & Viola, H. (2007). Behavioral tagging. J. Neuroscience, 27(28).
 *
 * PLAN-9: GAP-10 (Synaptic Tagging & Capture)
 */

import type { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, parseEmbedding } from "./internal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/synaptic-tagging");

export interface SynapticTaggingConfig {
  enabled: boolean;
  /** Strong event importance threshold */
  strongThreshold: number;
  /** Weak memory importance threshold (below this = candidate for capture) */
  weakThreshold: number;
  /** Temporal window before the strong event (ms) — default 2 hours */
  windowBeforeMs: number;
  /** Temporal window after the strong event (ms) — default 30 minutes */
  windowAfterMs: number;
  /** Minimum cosine similarity between strong and weak chunks */
  minSimilarity: number;
  /** Importance boost applied to captured chunks */
  captureBoost: number;
}

export const DEFAULT_STC_CONFIG: SynapticTaggingConfig = {
  enabled: true,
  strongThreshold: 0.7,
  weakThreshold: 0.4,
  windowBeforeMs: 2 * 60 * 60 * 1000,  // 2 hours
  windowAfterMs: 30 * 60 * 1000,        // 30 minutes
  minSimilarity: 0.5,
  captureBoost: 0.15,
};

export interface CaptureResult {
  strongChunkId: string;
  capturedChunkIds: string[];
  totalCaptured: number;
}

/**
 * When a high-importance chunk is created or boosted, find temporally-nearby
 * weak chunks that are semantically related, and "capture" them.
 *
 * Called after indexing or during consolidation when a chunk crosses the
 * strong threshold.
 */
export function captureNearbyWeakChunks(
  db: DatabaseSync,
  strongChunkId: string,
  config?: Partial<SynapticTaggingConfig>,
): CaptureResult {
  const cfg = { ...DEFAULT_STC_CONFIG, ...config };
  const result: CaptureResult = { strongChunkId, capturedChunkIds: [], totalCaptured: 0 };

  if (!cfg.enabled) return result;

  try {
    // Get the strong chunk
    const strong = db
      .prepare(
        `SELECT id, embedding, importance_score, created_at, hormonal_dopamine, hormonal_cortisol, hormonal_oxytocin
         FROM chunks WHERE id = ?`,
      )
      .get(strongChunkId) as {
      id: string;
      embedding: string;
      importance_score: number;
      created_at: number;
      hormonal_dopamine: number | null;
      hormonal_cortisol: number | null;
      hormonal_oxytocin: number | null;
    } | undefined;

    if (!strong || strong.importance_score < cfg.strongThreshold) return result;

    const strongEmb = parseEmbedding(strong.embedding);
    if (strongEmb.length === 0) return result;

    const windowStart = strong.created_at - cfg.windowBeforeMs;
    const windowEnd = strong.created_at + cfg.windowAfterMs;

    // Find weak chunks in temporal window
    const candidates = db
      .prepare(
        `SELECT id, embedding, importance_score
         FROM chunks
         WHERE importance_score < ?
           AND importance_score > 0.01
           AND created_at BETWEEN ? AND ?
           AND id != ?
           AND COALESCE(captured_by, '') = ''
           AND COALESCE(lifecycle, 'generated') IN ('generated', 'activated')
         LIMIT 50`,
      )
      .all(cfg.weakThreshold, windowStart, windowEnd, strongChunkId) as Array<{
      id: string;
      embedding: string;
      importance_score: number;
    }>;

    for (const candidate of candidates) {
      const candidateEmb = parseEmbedding(candidate.embedding);
      if (candidateEmb.length === 0) continue;

      const similarity = cosineSimilarity(strongEmb, candidateEmb);
      if (similarity >= cfg.minSimilarity) {
        // Capture: boost importance, set parent association, tag with dominant hormone
        db.prepare(
          `UPDATE chunks SET
             importance_score = MIN(1.0, importance_score + ?),
             captured_by = ?,
             hormonal_dopamine = COALESCE(hormonal_dopamine, 0) + COALESCE(?, 0) * 0.3,
             hormonal_cortisol = COALESCE(hormonal_cortisol, 0) + COALESCE(?, 0) * 0.3,
             hormonal_oxytocin = COALESCE(hormonal_oxytocin, 0) + COALESCE(?, 0) * 0.3
           WHERE id = ?`,
        ).run(
          cfg.captureBoost,
          strongChunkId,
          strong.hormonal_dopamine,
          strong.hormonal_cortisol,
          strong.hormonal_oxytocin,
          candidate.id,
        );

        result.capturedChunkIds.push(candidate.id);
        result.totalCaptured++;
      }
    }

    if (result.totalCaptured > 0) {
      log.debug("synaptic capture", {
        strongChunk: strongChunkId.slice(0, 8),
        captured: result.totalCaptured,
      });
    }
  } catch (err) {
    log.debug(`synaptic capture failed: ${String(err)}`);
  }

  return result;
}

/**
 * Check if a newly indexed/scored chunk crosses the strong threshold
 * and should trigger synaptic capture.
 */
export function shouldTriggerCapture(
  importanceScore: number,
  config?: Partial<SynapticTaggingConfig>,
): boolean {
  const cfg = { ...DEFAULT_STC_CONFIG, ...config };
  return cfg.enabled && importanceScore >= cfg.strongThreshold;
}
