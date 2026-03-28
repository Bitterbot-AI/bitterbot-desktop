/**
 * FadeMem importance scoring based on the Ebbinghaus forgetting curve.
 * Ported from ai-engine/memory_manager.py (FadeMemManager).
 *
 * LIFECYCLE-ONLY: As of the SOTA memory upgrade, importance scores are used
 * exclusively for memory lifecycle management (consolidation, forgetting,
 * dream-seeding, and merging). They are NOT applied as a retrieval ranking
 * penalty. Search ranking uses Reciprocal Rank Fusion (RRF) across vector
 * and keyword modalities, with an optional recency boost — see rrf.ts and
 * recency-boost.ts. This decoupling prevents the "catastrophic forgetting"
 * anti-pattern where old but critical facts get mathematically buried by
 * the Ebbinghaus decay multiplier.
 *
 * Formula: I(t) = S(t) * f(accessCount) * e^(-λ_eff * Δt)
 *
 * Where:
 *   S(t) = semantic relevance (initial importance or search score)
 *   f(n) = 1 - e^(-0.2 * (n + 1))  — saturating frequency factor
 *          n=0 → 0.181, n=1 → 0.330, n=5 → 0.699 (never-accessed chunks stay alive)
 *   Δt   = time since last access (ms), not since creation
 *   λ    = decay rate per millisecond
 *   λ_eff = λ * (1 - |emotionalValence| * emotionDecayResistance)
 *
 * Target behaviour with default λ = 5e-10/ms:
 *   access=0 → survives ~6 days, fades by ~14 days
 *   access=1 → survives ~14 days, fades by ~28 days
 *   access=5 → survives ~60 days+
 *   High emotional valence extends survival by up to 2×
 */

export type ImportanceInput = {
  semanticRelevance: number;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  emotionalValence?: number | null;
};

export type PromotionTier = "long_term" | "mid_term";

// ~5e-10/ms ≈ memories with access=1 survive ~14 days before hitting forget threshold
const DEFAULT_DECAY_RATE = 0.0000000005;
const DEFAULT_PROMOTE_LTM = 0.7;
const DEFAULT_PROMOTE_MTM = 0.4;
// Lower forget threshold — gives the dream engine time to rescue fading chunks
const DEFAULT_FORGET = 0.02;
// Emotional valence reduces decay by up to 50% at max valence
const DEFAULT_EMOTION_DECAY_RESISTANCE = 0.5;

export function calculateImportance(
  input: ImportanceInput,
  decayRate = DEFAULT_DECAY_RATE,
  emotionDecayResistance = DEFAULT_EMOTION_DECAY_RESISTANCE,
): number {
  const now = Date.now();

  // Decay based on time since last access (rehearsal), not creation.
  // This ensures recently-accessed chunks retain importance regardless of age.
  const deltaT = Math.max(0, now - input.lastAccessedAt);

  // Saturating frequency factor with steeper curve (0.2 instead of 0.1).
  // access=0 → 0.181 (above forget threshold of 0.05)
  // access=1 → 0.330, access=3 → 0.551, access=5 → 0.699
  // Each retrieval significantly boosts survival.
  const frequencyFactor = 1.0 - Math.exp(-0.2 * (input.accessCount + 1));

  // Emotional valence modulation: strong emotions (high absolute valence)
  // reduce the effective decay rate, causing emotionally significant memories
  // to persist longer. At valence=±1 with resistance=0.5, decay halves.
  const valence = input.emotionalValence ?? 0;
  const effectiveDecayRate =
    emotionDecayResistance > 0
      ? decayRate * (1 - Math.abs(valence) * emotionDecayResistance)
      : decayRate;

  // Exponential time decay from last access
  const timeDecay = Math.exp(-effectiveDecayRate * deltaT);

  return input.semanticRelevance * frequencyFactor * timeDecay;
}

export function shouldPromote(
  score: number,
  promoteThreshold = DEFAULT_PROMOTE_LTM,
  midTermThreshold = DEFAULT_PROMOTE_MTM,
): PromotionTier | null {
  if (score >= promoteThreshold) {
    return "long_term";
  }
  if (score >= midTermThreshold) {
    return "mid_term";
  }
  return null;
}

export function shouldForget(score: number, forgetThreshold = DEFAULT_FORGET): boolean {
  return score < forgetThreshold;
}

/**
 * Compute the multiplicative boost factor for a search result based on its
 * importance score. Formula: `1 - weight + weight * importanceScore`.
 *
 * - importanceScore=1.0 (fresh/default) → boost=1.0 (no change)
 * - importanceScore=0.0 (forgotten)     → boost=1-weight (max penalty)
 * - weight=0                            → boost=1.0 always (disabled)
 */
export function computeImportanceBoost(importanceScore: number, weight: number): number {
  if (weight <= 0) return 1;
  return 1 - weight + weight * importanceScore;
}
