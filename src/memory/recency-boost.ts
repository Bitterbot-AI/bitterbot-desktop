/**
 * Recency boost: exponential temporal scoring for memory retrieval.
 *
 * Applied as a post-RRF multiplier so that recently accessed or updated
 * memories naturally rise above older ones without penalizing long-term
 * critical facts (which is what the old importance-based multiplier did).
 *
 * Formula:
 *   RecencyBoost = α × e^(-λ × Δt)
 *   Final_Score  = RRF_Score × (1 + RecencyBoost)
 *
 * Where:
 *   α      = max boost magnitude (default 0.5 → up to 50% boost)
 *   λ      = ln(2) / halfLife_ms
 *   Δt     = now - max(updated_at, last_accessed_at)
 *   halfLife = 48 hours (default)
 *
 * Timeline (default settings):
 *   t=0h   → multiplier 1.50  (50% boost)
 *   t=24h  → multiplier ~1.35
 *   t=48h  → multiplier 1.25  (half decayed)
 *   t=96h  → multiplier ~1.12
 *   t=168h → multiplier ~1.05 (effectively neutral after ~1 week)
 */

const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_ALPHA = 0.5;
const DEFAULT_HALF_LIFE_HOURS = 48;

export type RecencyConfig = {
  /** Enable recency boost (default: true). */
  enabled: boolean;
  /** Max boost magnitude, 0–1. Default 0.5 = up to 50% boost for very recent items. */
  alpha: number;
  /** Half-life in hours. After this many hours, the boost is halved. Default 48. */
  halfLifeHours: number;
};

export const DEFAULT_RECENCY_CONFIG: RecencyConfig = {
  enabled: true,
  alpha: DEFAULT_ALPHA,
  halfLifeHours: DEFAULT_HALF_LIFE_HOURS,
};

/**
 * Compute the recency boost multiplier for a memory chunk.
 *
 * @param updatedAtMs       When the chunk was last modified (epoch ms)
 * @param lastAccessedAtMs  When the chunk was last retrieved (epoch ms), or null
 * @param config            Recency configuration
 * @param nowMs             Current time (epoch ms), defaults to Date.now()
 * @returns A multiplier >= 1.0. Apply as: `finalScore = rrfScore * boost`
 */
export function computeRecencyBoost(
  updatedAtMs: number,
  lastAccessedAtMs: number | null,
  config: RecencyConfig,
  nowMs?: number,
): number {
  if (!config.enabled || config.alpha <= 0) return 1.0;

  const now = nowMs ?? Date.now();
  // Use the most recent timestamp as the reference point
  const referenceTime = Math.max(updatedAtMs, lastAccessedAtMs ?? 0);
  const deltaMs = Math.max(0, now - referenceTime);

  const halfLifeMs = config.halfLifeHours * MS_PER_HOUR;
  if (halfLifeMs <= 0) return 1.0;

  const lambda = Math.LN2 / halfLifeMs;
  const boost = config.alpha * Math.exp(-lambda * deltaMs);

  return 1 + boost;
}
