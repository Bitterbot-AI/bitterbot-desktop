/**
 * Pure math functions for the Curiosity Engine's multi-component reward system.
 * Adapted from bitterbot-network's grokified_curiosity_engine.py.
 *
 * Composite reward: r_i = tanh(w1*novelty + w2*surprise + w3*informationGain + w4*contradiction)
 */

import type { CuriosityWeights } from "./curiosity-types.js";
import { DEFAULT_CURIOSITY_WEIGHTS } from "./curiosity-types.js";
import { cosineSimilarity } from "./internal.js";

/**
 * Novelty: cosine distance from nearest knowledge region centroid.
 * High value = chunk is far from any known region.
 */
export function computeNovelty(
  chunkEmbedding: number[],
  regionCentroids: number[][],
): number {
  if (regionCentroids.length === 0) return 1.0;

  let maxSimilarity = -1;
  for (const centroid of regionCentroids) {
    const sim = cosineSimilarity(chunkEmbedding, centroid);
    if (sim > maxSimilarity) maxSimilarity = sim;
  }
  // Convert similarity to distance: novelty = 1 - maxSimilarity
  return Math.max(0, 1 - maxSimilarity);
}

/**
 * Surprise: deviation from a region's historical mean embedding (prediction error).
 * High value = chunk deviates from what's expected in its region.
 */
export function computeSurprise(
  chunkEmbedding: number[],
  regionCentroid: number[] | null,
  regionPredictionError: number,
): number {
  if (!regionCentroid || regionCentroid.length === 0) return 0.5;

  const sim = cosineSimilarity(chunkEmbedding, regionCentroid);
  const distance = 1 - sim;
  // Surprise is how much this chunk deviates beyond the region's typical error
  return Math.min(1, Math.max(0, distance - regionPredictionError * 0.5));
}

/**
 * Information gain: how much a new chunk would shift the region centroid.
 * Large shifts indicate genuinely new information.
 */
export function computeInformationGain(
  chunkEmbedding: number[],
  regionCentroid: number[],
  regionChunkCount: number,
): number {
  if (regionCentroid.length === 0 || regionChunkCount === 0) return 0.5;

  // Compute the hypothetical new centroid
  const n = regionChunkCount;
  const newCentroid = new Array<number>(regionCentroid.length);
  for (let i = 0; i < regionCentroid.length; i++) {
    newCentroid[i] =
      ((regionCentroid[i] ?? 0) * n + (chunkEmbedding[i] ?? 0)) / (n + 1);
  }

  // Information gain = distance between old and new centroid
  const shift = 1 - cosineSimilarity(regionCentroid, newCentroid);
  // Scale: small regions are more affected, amplify the gain for small n
  const scaleFactor = Math.min(3, 10 / (n + 1));
  return Math.min(1, shift * scaleFactor);
}

/**
 * Contradiction: detects conflicting information within a region.
 * High similarity in embedding space + different content hash = contradiction signal.
 */
export function computeContradiction(
  chunkEmbedding: number[],
  chunkHash: string,
  neighborEmbeddings: Array<{ embedding: number[]; hash: string }>,
): number {
  if (neighborEmbeddings.length === 0) return 0;

  let maxContradiction = 0;
  for (const neighbor of neighborEmbeddings) {
    const sim = cosineSimilarity(chunkEmbedding, neighbor.embedding);
    // High similarity + different hash = potential contradiction
    if (sim >= 0.85 && chunkHash !== neighbor.hash) {
      const contradiction = sim * 0.8; // Scale down slightly
      if (contradiction > maxContradiction) {
        maxContradiction = contradiction;
      }
    }
  }
  return maxContradiction;
}

/**
 * Multi-component curiosity reward: combined signal for a chunk.
 */
export function computeCuriosityReward(
  components: {
    novelty: number;
    surprise: number;
    informationGain: number;
    contradiction: number;
  },
  weights?: Partial<CuriosityWeights>,
): number {
  const w = { ...DEFAULT_CURIOSITY_WEIGHTS, ...weights };
  const raw =
    w.novelty * components.novelty +
    w.surprise * components.surprise +
    w.informationGain * components.informationGain +
    w.contradiction * components.contradiction;
  return Math.tanh(raw);
}

/**
 * Learning progress: rate of change of prediction error over time.
 * Positive = region is improving (getting better predictions).
 * Negative = region is getting worse (interesting new information arriving).
 */
export function computeLearningProgress(
  errorHistory: Array<{ error: number; timestamp: number }>,
): number {
  if (errorHistory.length < 2) return 0;

  // Linear regression on prediction error over time
  const n = errorHistory.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  const t0 = errorHistory[0]!.timestamp;

  for (const entry of errorHistory) {
    const x = (entry.timestamp - t0) / (1000 * 60); // minutes
    const y = entry.error;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return 0;

  const slope = (n * sumXY - sumX * sumY) / denom;
  // Negative slope = errors decreasing = learning progress
  // Return as positive value clamped to [-1, 1]
  return Math.max(-1, Math.min(1, -slope * 100));
}

