// The curated "featured" model set — the lean, defensible menu Bitterbot
// surfaces first, on top of the full live-discovered catalog. Discovery decides
// which models EXIST; this decides which we recommend and how we tier them.
//
// It is an overlay, not a filter: a model that matches no rule is still
// selectable (search + "show all"), it just isn't promoted. Rules that name a
// provider the node hasn't configured simply never match, so the featured menu
// lights up tier-by-tier as providers are added.
//
// Matching is by lowercased provider + id prefix so it survives the exact IDs a
// provider serves (e.g. anthropic returns both claude-opus-5 and claude-opus-4-8
// for the same frontier slot; a dated snapshot like
// claude-sonnet-4-5-20250929 is NOT featured, keeping the promoted list tight).
//
// Source: the 2026-08 model-menu research pass (three tiers, ~12 models).

export type ModelTier = "frontier" | "mid" | "workhorse";

type FeaturedRule = {
  provider: string;
  /** Lowercased id prefix; an entry is featured when its id startsWith this. */
  prefix: string;
  tier: ModelTier;
  /** The single recommended everyday default (favor consistency, not peak). */
  isDefault?: boolean;
};

// Order is presentation order within a tier (first listed wins on ties).
const FEATURED_RULES: readonly FeaturedRule[] = [
  // ---- Anthropic (anthropic-messages) ----
  { provider: "anthropic", prefix: "claude-opus-5", tier: "frontier" },
  { provider: "anthropic", prefix: "claude-opus-4-8", tier: "frontier" },
  { provider: "anthropic", prefix: "claude-fable-5", tier: "frontier" },
  { provider: "anthropic", prefix: "claude-sonnet-5", tier: "mid", isDefault: true },
  { provider: "anthropic", prefix: "claude-haiku-4-5", tier: "workhorse" },

  // ---- OpenAI (openai-responses) ----
  { provider: "openai", prefix: "gpt-5.5", tier: "frontier" },
  { provider: "openai", prefix: "gpt-5-pro", tier: "frontier" },
  { provider: "openai", prefix: "gpt-5.6", tier: "frontier" },
  { provider: "openai", prefix: "gpt-5-mini", tier: "mid" },
  { provider: "openai", prefix: "gpt-oss-120b", tier: "workhorse" },
  { provider: "openai", prefix: "gpt-oss-20b", tier: "workhorse" },

  // ---- Google (google-generative-ai) ----
  { provider: "google", prefix: "gemini-3-pro", tier: "frontier" },
  { provider: "google", prefix: "gemini-3.1-pro", tier: "frontier" },
  { provider: "google", prefix: "gemini-3-flash", tier: "mid" },
  { provider: "google", prefix: "gemini-3.1-flash", tier: "mid" },

  // ---- xAI (openai-completions) ----
  { provider: "xai", prefix: "grok-4", tier: "frontier" },

  // ---- Open-weight, direct providers ----
  { provider: "zai", prefix: "glm-4.6", tier: "mid" },
  { provider: "zai", prefix: "glm-5", tier: "mid" },
  { provider: "inferencer", prefix: "qwen3", tier: "workhorse" },

  // ---- Open-weight via OpenRouter (ids carry a vendor sub-path) ----
  { provider: "openrouter", prefix: "openai/gpt-oss-120b", tier: "workhorse" },
  { provider: "openrouter", prefix: "openai/gpt-oss-20b", tier: "workhorse" },
  { provider: "openrouter", prefix: "z-ai/glm-4.6", tier: "mid" },
  { provider: "openrouter", prefix: "deepseek/deepseek-v3", tier: "mid" },
];

export type FeaturedInfo = {
  featured: boolean;
  tier?: ModelTier;
  isDefault?: boolean;
};

const NOT_FEATURED: FeaturedInfo = { featured: false };

/**
 * Classify a (provider, id) pair against the curated featured rules. Returns
 * { featured: false } when nothing matches — callers treat that as "still
 * selectable, just not promoted".
 */
export function classifyFeatured(
  provider: string | null | undefined,
  id: string | null | undefined,
): FeaturedInfo {
  const p = (provider ?? "").trim().toLowerCase();
  const modelId = (id ?? "").trim().toLowerCase();
  if (!p || !modelId) {
    return NOT_FEATURED;
  }
  for (const rule of FEATURED_RULES) {
    if (rule.provider === p && modelId.startsWith(rule.prefix)) {
      return { featured: true, tier: rule.tier, isDefault: rule.isDefault };
    }
  }
  return NOT_FEATURED;
}

/** Tier display order + labels for pickers/wizards (frontier first). */
export const TIER_ORDER: readonly ModelTier[] = ["frontier", "mid", "workhorse"];

export const TIER_LABEL: Record<ModelTier, string> = {
  frontier: "Frontier",
  mid: "Mid",
  workhorse: "Workhorse",
};
