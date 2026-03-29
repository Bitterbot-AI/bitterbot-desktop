/**
 * Temporal relevance scoring for memory retrieval.
 *
 * Applies query-intent-sensitive temporal decay to search results.
 * Different query intents ("what am I working on?" vs "when did I...")
 * need different temporal biases. Epistemic layers have different
 * natural half-lives reflecting how quickly knowledge becomes stale.
 *
 * Plan 7, Phase 3.
 */

export type QueryTemporalIntent = "current" | "historical" | "timeless" | "default";

const CURRENT_PATTERNS =
  /\b(?:currently|right now|at the moment|these days|am i|what's the status|what am i|working on now|today)\b/i;
const HISTORICAL_PATTERNS =
  /\b(?:when did|last time|used to|history of|previously|back when|remember when|did i ever|ago)\b/i;
const TIMELESS_PATTERNS =
  /\b(?:what is|define|how does|explain|always|never|rule|preference|what are)\b/i;

/**
 * Detect the temporal intent of a search query.
 */
export function detectTemporalIntent(query: string): QueryTemporalIntent {
  if (CURRENT_PATTERNS.test(query)) return "current";
  if (HISTORICAL_PATTERNS.test(query)) return "historical";
  if (TIMELESS_PATTERNS.test(query)) return "timeless";
  return "default";
}

/** Half-life in days by epistemic layer. Infinity = no decay. */
const LAYER_HALF_LIVES: Record<string, number> = {
  directive: Infinity,
  identity: 180,
  world_fact: 90,
  mental_model: 60,
  experience: 30,
};

const DEFAULT_HALF_LIFE = 45;

/**
 * Compute temporal relevance multiplier for a search result.
 *
 * For "current" queries: aggressive decay (half-life / 3)
 * For "historical" queries: inverted — older is slightly better
 * For "timeless" queries: no temporal adjustment
 * For "default" queries: standard layer-based decay
 *
 * Returns a multiplier in (0, 1.3] to apply to the search score.
 */
export function temporalRelevanceMultiplier(params: {
  intent: QueryTemporalIntent;
  epistemicLayer: string | null;
  createdAt: number;
  updatedAt: number | null;
  now?: number;
}): number {
  const { intent, epistemicLayer, createdAt, updatedAt } = params;
  const now = params.now ?? Date.now();

  if (intent === "timeless") return 1.0;

  const layer = epistemicLayer ?? "experience";
  const halfLifeDays = LAYER_HALF_LIVES[layer] ?? DEFAULT_HALF_LIFE;

  if (halfLifeDays === Infinity && intent !== "current") return 1.0;

  const effectiveTimestamp = updatedAt ?? createdAt;
  const ageDays = (now - effectiveTimestamp) / (24 * 60 * 60 * 1000);

  if (intent === "current") {
    // Aggressive decay: even "timeless" layers get mild decay for "current" queries
    const effectiveHalfLife = halfLifeDays === Infinity ? 365 : halfLifeDays / 3;
    return Math.pow(0.5, ageDays / effectiveHalfLife);
  }

  if (intent === "historical") {
    // Slight preference for older results (capped at 1.3x)
    const ageFactor = Math.min(1.3, 1 + Math.log2(1 + ageDays / 30) * 0.1);
    // Still apply layer decay to prevent ancient garbage from surfacing
    const effectiveHL = halfLifeDays === Infinity ? 365 : halfLifeDays * 2;
    const decay = Math.pow(0.5, ageDays / effectiveHL);
    return ageFactor * decay;
  }

  // "default" intent: standard layer-based decay
  if (halfLifeDays === Infinity) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}
