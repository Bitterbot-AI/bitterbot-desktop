/**
 * PLAN-50: one place that answers "what does a token on this model cost?".
 *
 * Resolution order (first hit wins):
 *   1. `override`  — `models.providers.<p>.models[].cost` in config with any non-zero field.
 *   2. `catalog`   — the pi model registry (vendored pi-ai catalog + models.json), any non-zero field.
 *   3. `embedding-catalog` — the small vendored table below for embedding models, which the
 *      chat catalog does not carry.
 *   4. `local`     — ollama/vllm/local inference: $0 by construction, and NOT a gap.
 *   5. `unpriced`  — $0 with a flag so the UI and doctor can say "we do not know".
 *
 * Zero is never treated as a price. `DEFAULT_MODEL_COST` in config/defaults.ts stamps zeros on
 * unknown models, which previously made unpriced cloud models look free.
 */

import type { BitterbotConfig } from "../config/config.js";
import type {
  ModelPrice,
  PricingSource,
  UsageBuckets,
  UsageCost,
  UsageKind,
} from "./usage-ledger.types.js";
import { getLivePricingStatus, lookupLivePrice } from "./model-pricing-live.js";

export type ResolvedPricing = { price: ModelPrice; source: PricingSource };

export const LOCAL_MODEL_PROVIDERS: ReadonlySet<string> = new Set([
  "ollama",
  "vllm",
  "local",
  "lmstudio",
  "llamacpp",
  "llama.cpp",
  "mlx",
  "koboldcpp",
]);

/**
 * USD per 1M input tokens. Sources (fetched 2026-09-15):
 *  - OpenAI: https://developers.openai.com/api/docs/pricing (text-embedding-3-small $0.02,
 *    3-large $0.13, ada-002 $0.10; LiteLLM entries 2e-08 / 1.3e-07 / 1e-07 per token)
 *  - Google: https://ai.google.dev/gemini-api/docs/pricing (gemini-embedding-001 $0.15)
 *  - Voyage: https://docs.voyageai.com/docs/pricing (voyage-3-large $0.18, voyage-3.5 $0.06,
 *    voyage-3.5-lite $0.02, voyage-code-3 $0.18)
 * Models not listed here (e.g. newer Voyage generations) resolve to `unpriced` and are flagged
 * rather than guessed.
 */
export const EMBEDDING_PRICES_PER_MILLION: Readonly<Record<string, number>> = {
  "openai/text-embedding-3-small": 0.02,
  "openai/text-embedding-3-large": 0.13,
  "openai/text-embedding-ada-002": 0.1,
  "gemini/gemini-embedding-001": 0.15,
  "google/gemini-embedding-001": 0.15,
  "voyage/voyage-3-large": 0.18,
  "voyage/voyage-3.5": 0.06,
  "voyage/voyage-3.5-lite": 0.02,
  "voyage/voyage-3": 0.06,
  "voyage/voyage-code-3": 0.18,
};

/**
 * USD per 1M input CHARACTERS for text-to-speech (`kind: "tts"` rows store characters in
 * `input`). Source: https://developers.openai.com/api/docs/pricing (tts-1 $15/M, tts-1-hd $30/M).
 * ElevenLabs is subscription-billed per character and stays `unpriced`.
 */
export const TTS_PRICES_PER_MILLION_CHARS: Readonly<Record<string, number>> = {
  "openai/tts-1": 15,
  "openai/tts-1-hd": 30,
};

const ZERO_PRICE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MEMO_TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; value: ResolvedPricing }>();

export function hasNonzeroPrice(cost: Partial<ModelPrice> | null | undefined): cost is ModelPrice {
  if (!cost) {
    return false;
  }
  return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
}

function toPrice(cost: Partial<ModelPrice> & { cacheWrite1h?: number }): ModelPrice {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const price: ModelPrice = {
    input: n(cost.input),
    output: n(cost.output),
    cacheRead: n(cost.cacheRead),
    cacheWrite: n(cost.cacheWrite),
  };
  if (typeof cost.cacheWrite1h === "number" && cost.cacheWrite1h > 0) {
    price.cacheWrite1h = cost.cacheWrite1h;
  }
  return price;
}

/** Strip provider prefixes and Gemini's `models/` path so table lookups are stable. */
export function normalizeModelIdForPricing(provider: string, model: string): string {
  let id = model.trim();
  const prefix = `${provider}/`;
  if (id.startsWith(prefix)) {
    id = id.slice(prefix.length);
  }
  if (id.startsWith("models/")) {
    id = id.slice("models/".length);
  }
  return id;
}

export function isLocalModelProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  return LOCAL_MODEL_PROVIDERS.has(provider.trim().toLowerCase());
}

function lookupOverride(
  provider: string,
  model: string,
  cfg: BitterbotConfig | undefined,
): ModelPrice | undefined {
  const providers = cfg?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  return hasNonzeroPrice(entry?.cost) ? toPrice(entry.cost) : undefined;
}

function lookupEmbeddingCatalog(provider: string, model: string): ModelPrice | undefined {
  const key = `${provider.toLowerCase()}/${normalizeModelIdForPricing(provider, model)}`;
  const perMillion = EMBEDDING_PRICES_PER_MILLION[key];
  if (typeof perMillion !== "number") {
    return undefined;
  }
  return { input: perMillion, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function lookupTtsCatalog(provider: string, model: string): ModelPrice | undefined {
  const key = `${provider.toLowerCase()}/${normalizeModelIdForPricing(provider, model)}`;
  const perMillion = TTS_PRICES_PER_MILLION_CHARS[key];
  if (typeof perMillion !== "number") {
    return undefined;
  }
  return { input: perMillion, output: 0, cacheRead: 0, cacheWrite: 0 };
}

async function lookupCatalog(
  provider: string,
  model: string,
  cfg: BitterbotConfig | undefined,
): Promise<ModelPrice | undefined> {
  try {
    const { resolveModel } = await import("../agents/pi-embedded-runner/model.js");
    const resolved = resolveModel(provider, model, undefined, cfg);
    const cost = resolved.model?.cost as Partial<ModelPrice> | undefined;
    return hasNonzeroPrice(cost) ? toPrice(cost) : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveModelPricing(params: {
  provider: string | undefined | null;
  model: string | undefined | null;
  kind?: UsageKind;
  cfg?: BitterbotConfig;
  /** Event time; the live overlay answers with the snapshot in force then. */
  ts?: number;
}): Promise<ResolvedPricing> {
  const provider = params.provider?.trim() ?? "";
  const model = params.model?.trim() ?? "";
  if (!provider || !model) {
    return { price: ZERO_PRICE, source: "unpriced" };
  }
  const kind = params.kind ?? "chat";
  const day = typeof params.ts === "number" ? Math.floor(params.ts / 86_400_000) : "now";
  const memoKey = `${kind}|${provider}|${model}|${day}`;
  const cached = memo.get(memoKey);
  const now = Date.now();
  if (cached && now - cached.at < MEMO_TTL_MS) {
    return cached.value;
  }

  let value: ResolvedPricing | undefined;
  const override = lookupOverride(provider, model, params.cfg);
  if (override) {
    value = { price: override, source: "override" };
  }
  if (!value && kind === "embedding") {
    const embedding = lookupEmbeddingCatalog(provider, model);
    if (embedding) {
      value = { price: embedding, source: "embedding-catalog" };
    }
  }
  if (!value && kind === "tts") {
    const tts = lookupTtsCatalog(provider, model);
    if (tts) {
      value = { price: tts, source: "embedding-catalog" };
    }
  }
  if (!value && isLocalModelProvider(provider)) {
    value = { price: ZERO_PRICE, source: "local" };
  }
  if (!value) {
    const catalog = await lookupCatalog(provider, model, params.cfg);
    if (catalog) {
      value = { price: catalog, source: "catalog" };
    }
  }
  if (!value && kind === "search" && provider === "perplexity") {
    // Perplexity is served natively and via OpenRouter; the vendored catalog carries the latter.
    const viaOpenRouter = await lookupCatalog(
      "openrouter",
      `perplexity/${normalizeModelIdForPricing(provider, model)}`,
      params.cfg,
    );
    if (viaOpenRouter) {
      value = { price: viaOpenRouter, source: "catalog" };
    }
  }
  if (!value) {
    const live = lookupLivePrice(provider, model, params.ts);
    if (live) {
      value = { price: toPrice(live.price), source: "live" };
    }
  }
  if (!value) {
    value = { price: ZERO_PRICE, source: "unpriced" };
    // Do not remember "unpriced" before the first live snapshot has landed: backfilled history
    // would otherwise stay $0 for five minutes after prices arrive.
    if (getLivePricingStatus().snapshots === 0) {
      return value;
    }
  }
  memo.set(memoKey, { at: now, value });
  return value;
}

export function resetModelPricingMemoForTest(): void {
  memo.clear();
}

/** Price exclusive buckets. `batch` halves every bucket (OpenAI/Anthropic/Gemini Batch APIs). */
export function priceUsage(
  price: ModelPrice,
  usage: UsageBuckets,
  opts?: {
    batch?: boolean;
    cacheTtl?: "5m" | "1h" | "none" | null;
    provider?: string | null;
    /** Where the price came from; a user override is taken as-is, never scaled. */
    source?: PricingSource;
  },
): UsageCost {
  const factor = opts?.batch ? 0.5 : 1;
  const per = (tokens: number, perMillion: number) => (tokens * perMillion * factor) / 1_000_000;
  const input = per(usage.input, price.input);
  const cacheRead = per(usage.cacheRead, price.cacheRead);
  // Anthropic bills 1-hour cache writes at 2x base input vs 1.25x for 5-minute writes. Prefer
  // a published 1h rate (live snapshots carry one); otherwise scale the catalog's 5-minute rate.
  // A user override is trusted verbatim.
  let cacheWriteRate = price.cacheWrite;
  if (opts?.cacheTtl === "1h" && opts.source !== "override") {
    if (typeof price.cacheWrite1h === "number" && price.cacheWrite1h > 0) {
      cacheWriteRate = price.cacheWrite1h;
    } else if ((opts.provider ?? "").toLowerCase() === "anthropic") {
      cacheWriteRate = price.cacheWrite * (2 / 1.25);
    }
  }
  const cacheWrite = per(usage.cacheWrite, cacheWriteRate);
  const output = per(usage.output, price.output);
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}
