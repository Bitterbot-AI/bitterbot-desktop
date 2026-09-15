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

function toPrice(cost: Partial<ModelPrice>): ModelPrice {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: n(cost.input),
    output: n(cost.output),
    cacheRead: n(cost.cacheRead),
    cacheWrite: n(cost.cacheWrite),
  };
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
}): Promise<ResolvedPricing> {
  const provider = params.provider?.trim() ?? "";
  const model = params.model?.trim() ?? "";
  if (!provider || !model) {
    return { price: ZERO_PRICE, source: "unpriced" };
  }
  const memoKey = `${params.kind ?? "chat"}|${provider}|${model}`;
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
  if (!value && params.kind === "embedding") {
    const embedding = lookupEmbeddingCatalog(provider, model);
    if (embedding) {
      value = { price: embedding, source: "embedding-catalog" };
    }
  }
  if (!value && isLocalModelProvider(provider)) {
    value = { price: ZERO_PRICE, source: "local" };
  }
  if (!value && params.kind !== "embedding") {
    const catalog = await lookupCatalog(provider, model, params.cfg);
    if (catalog) {
      value = { price: catalog, source: "catalog" };
    }
  }
  if (!value && params.kind === "embedding") {
    // A chat-catalog hit for an embedding id is unlikely but harmless.
    const catalog = await lookupCatalog(provider, model, params.cfg);
    if (catalog) {
      value = { price: catalog, source: "catalog" };
    }
  }
  if (!value) {
    value = { price: ZERO_PRICE, source: "unpriced" };
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
  opts?: { batch?: boolean },
): UsageCost {
  const factor = opts?.batch ? 0.5 : 1;
  const per = (tokens: number, perMillion: number) => (tokens * perMillion * factor) / 1_000_000;
  const input = per(usage.input, price.input);
  const cacheRead = per(usage.cacheRead, price.cacheRead);
  const cacheWrite = per(usage.cacheWrite, price.cacheWrite);
  const output = per(usage.output, price.output);
  return { input, cacheRead, cacheWrite, output, total: input + cacheRead + cacheWrite + output };
}
