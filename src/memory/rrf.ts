/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists into
 * a single unified ranking without requiring comparable score scales.
 *
 * Formula: RRF_Score(d) = Σ_L  w_L / (k + rank_L(d))
 *
 * The constant k (default 60) acts as a smoothing factor that mitigates
 * the influence of outlier results, rewarding documents that appear
 * consistently in the upper tiers of multiple search modalities. Each list
 * may carry a weight w_L (default 1, so the unweighted formula is the
 * default); a weight of 0 removes that list's contribution entirely, and an
 * entry whose every contribution is 0 is dropped from the fused output.
 *
 * Reference: Cormack, Clarke & Buettcher (2009), "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods"
 */

export type RankedEntry<T = Record<string, unknown>> = {
  id: string;
  rank: number;
  payload: T;
};

export type FusedEntry<T = Record<string, unknown>> = {
  id: string;
  score: number;
  sourceRanks: Record<string, number>;
  payload: T;
};

export const DEFAULT_RRF_K = 60;

/** A ranked list handed to `rrfFuse`, optionally weighted. */
export type RankedList<T = Record<string, unknown>> = {
  name: string;
  entries: Array<RankedEntry<T>>;
  /**
   * Multiplier on this list's contribution, `w / (k + rank)`. Default 1.
   * 0 silences the list without changing which candidates it retrieved;
   * a negative or non-finite value is treated as 1 (callers validate and
   * warn; this layer only stays well defined).
   */
  weight?: number;
};

export function sanitizeRrfWeight(weight: number | undefined): number {
  return typeof weight === "number" && Number.isFinite(weight) && weight >= 0 ? weight : 1;
}

export function sanitizeRrfK(k: number | undefined): number {
  return typeof k === "number" && Number.isFinite(k) && k > 0 ? k : DEFAULT_RRF_K;
}

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param lists  Named ranked lists. Each entry must have an `id` and `rank` (1-based).
 *               A list may carry a `weight` (default 1).
 * @param k      Smoothing constant (default 60). Higher = more skeptical of single-list outliers.
 * @returns      Fused results sorted by RRF score descending. Ids whose total
 *               contribution is 0 (found only by zero-weighted lists) are omitted.
 */
export function rrfFuse<T = Record<string, unknown>>(
  lists: Array<RankedList<T>>,
  k = DEFAULT_RRF_K,
): Array<FusedEntry<T>> {
  if (lists.length === 0) {
    return [];
  }
  const effectiveK = sanitizeRrfK(k);

  const scores = new Map<
    string,
    { score: number; sourceRanks: Record<string, number>; payload: T }
  >();

  for (const list of lists) {
    const weight = sanitizeRrfWeight(list.weight);
    for (const entry of list.entries) {
      const existing = scores.get(entry.id);
      const contribution = weight / (effectiveK + entry.rank);

      if (existing) {
        existing.score += contribution;
        existing.sourceRanks[list.name] = entry.rank;
      } else {
        scores.set(entry.id, {
          score: contribution,
          sourceRanks: { [list.name]: entry.rank },
          payload: entry.payload,
        });
      }
    }
  }

  return [...scores.entries()]
    .filter(([, data]) => data.score > 0)
    .map(([id, data]) => ({
      id,
      score: data.score,
      sourceRanks: data.sourceRanks,
      payload: data.payload,
    }))
    .toSorted((a, b) => b.score - a.score);
}
