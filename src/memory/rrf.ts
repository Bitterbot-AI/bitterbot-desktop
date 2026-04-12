/**
 * Reciprocal Rank Fusion (RRF) — merges multiple ranked result lists into
 * a single unified ranking without requiring comparable score scales.
 *
 * Formula: RRF_Score(d) = Σ_L  1 / (k + rank_L(d))
 *
 * The constant k (default 60) acts as a smoothing factor that mitigates
 * the influence of outlier results, rewarding documents that appear
 * consistently in the upper tiers of multiple search modalities.
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

/**
 * Fuse multiple ranked lists using Reciprocal Rank Fusion.
 *
 * @param lists  Named ranked lists. Each entry must have an `id` and `rank` (1-based).
 * @param k      Smoothing constant (default 60). Higher = more skeptical of single-list outliers.
 * @returns      Fused results sorted by RRF score descending.
 */
export function rrfFuse<T = Record<string, unknown>>(
  lists: Array<{ name: string; entries: Array<RankedEntry<T>> }>,
  k = 60,
): Array<FusedEntry<T>> {
  if (lists.length === 0) {
    return [];
  }

  const scores = new Map<
    string,
    { score: number; sourceRanks: Record<string, number>; payload: T }
  >();

  for (const list of lists) {
    for (const entry of list.entries) {
      const existing = scores.get(entry.id);
      const contribution = 1 / (k + entry.rank);

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
    .map(([id, data]) => ({
      id,
      score: data.score,
      sourceRanks: data.sourceRanks,
      payload: data.payload,
    }))
    .toSorted((a, b) => b.score - a.score);
}
