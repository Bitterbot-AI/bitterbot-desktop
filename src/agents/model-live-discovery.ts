// Live model discovery: ask each provider what it actually serves right now,
// instead of trusting the vendored @mariozechner/pi-ai catalog (which goes
// stale — it lists retired snapshots the provider now 404s and omits models
// shipped after the SDK was published). Discovery returns the authoritative
// set of model IDs for a provider; the catalog layer joins them against
// vendored metadata (context window, modalities, cost) and synthesizes entries
// for IDs the SDK has never heard of.
//
// Every adapter degrades safely: any non-200, timeout, parse failure, or
// missing credential returns null, and the caller keeps the vendored/curated
// list. Discovery can only ADD correctness, never remove a working catalog.

export type ProviderDiscoveryTarget = {
  provider: string;
  /** Base URL from the provider's catalog/config, e.g. https://api.anthropic.com */
  baseUrl?: string | null;
  /** Resolved API key / bearer token for the provider, if any. */
  apiKey?: string | null;
  /** pi-ai API family, e.g. "anthropic-messages", "openai-completions". */
  api?: string | null;
};

export type DiscoveredModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  input?: Array<"text" | "image">;
};

/** Injectable so unit tests never touch the network. Mirrors global fetch. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const DEFAULT_TIMEOUT_MS = 6000;

type Adapter = "anthropic" | "openai" | "google" | null;

// Map a pi-ai API family to a discovery adapter. Families we can't list over a
// simple key+GET (AWS SigV4 bedrock, OAuth codex/gemini-cli/antigravity, vertex,
// azure) return null and fall back to the curated/vendored list.
export function adapterForApi(api: string | null | undefined): Adapter {
  const a = (api ?? "").trim().toLowerCase();
  if (a === "anthropic-messages") {
    return "anthropic";
  }
  if (a === "openai-completions" || a === "openai-responses") {
    return "openai";
  }
  if (a === "google-generative-ai") {
    return "google";
  }
  return null;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Anthropic + anthropic-compatible: GET {baseUrl}/v1/models, x-api-key auth.
// Response: { data: [{ id, display_name }] }.
async function discoverAnthropicStyle(
  target: ProviderDiscoveryTarget,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DiscoveredModel[] | null> {
  if (!target.baseUrl || !target.apiKey) {
    return null;
  }
  const url = `${trimTrailingSlash(target.baseUrl)}/v1/models?limit=1000`;
  const json = await fetchJson(
    fetchImpl,
    url,
    {
      "x-api-key": target.apiKey,
      "anthropic-version": "2023-06-01",
    },
    timeoutMs,
  );
  if (!isRecord(json) || !Array.isArray(json.data)) {
    return null;
  }
  const out: DiscoveredModel[] = [];
  for (const entry of json.data) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      continue;
    }
    const name = typeof entry.display_name === "string" ? entry.display_name.trim() : undefined;
    out.push({ id, name: name || undefined });
  }
  return out.length > 0 ? out : null;
}

// OpenAI + OpenAI-compatible (xai, zai, openrouter, groq, mistral, ...):
// GET {baseUrl}/models, Bearer auth. Response: { data: [{ id, context_length? }] }.
async function discoverOpenAIStyle(
  target: ProviderDiscoveryTarget,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DiscoveredModel[] | null> {
  if (!target.baseUrl) {
    return null;
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (target.apiKey) {
    headers.authorization = `Bearer ${target.apiKey}`;
  }
  const url = `${trimTrailingSlash(target.baseUrl)}/models`;
  const json = await fetchJson(fetchImpl, url, headers, timeoutMs);
  if (!isRecord(json) || !Array.isArray(json.data)) {
    return null;
  }
  const out: DiscoveredModel[] = [];
  for (const entry of json.data) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      continue;
    }
    const ctx =
      typeof entry.context_length === "number" && entry.context_length > 0
        ? entry.context_length
        : undefined;
    const name = typeof entry.name === "string" ? entry.name.trim() : undefined;
    out.push({ id, name: name || undefined, contextWindow: ctx });
  }
  return out.length > 0 ? out : null;
}

// Google Generative Language: GET {baseUrl}/models?key=KEY.
// Response: { models: [{ name: "models/gemini-...", displayName, inputTokenLimit,
// supportedGenerationMethods: [...] }] }. Keep only content-generation models.
async function discoverGoogleStyle(
  target: ProviderDiscoveryTarget,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<DiscoveredModel[] | null> {
  if (!target.baseUrl || !target.apiKey) {
    return null;
  }
  const url = `${trimTrailingSlash(target.baseUrl)}/models?key=${encodeURIComponent(
    target.apiKey,
  )}&pageSize=1000`;
  const json = await fetchJson(fetchImpl, url, { accept: "application/json" }, timeoutMs);
  if (!isRecord(json) || !Array.isArray(json.models)) {
    return null;
  }
  const out: DiscoveredModel[] = [];
  for (const entry of json.models) {
    if (!isRecord(entry)) {
      continue;
    }
    const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!rawName) {
      continue;
    }
    const methods = Array.isArray(entry.supportedGenerationMethods)
      ? entry.supportedGenerationMethods
      : [];
    // Skip embedding/other models that can't back a chat agent.
    if (methods.length > 0 && !methods.includes("generateContent")) {
      continue;
    }
    const id = rawName.replace(/^models\//, "");
    if (!id) {
      continue;
    }
    const name = typeof entry.displayName === "string" ? entry.displayName.trim() : undefined;
    const ctx =
      typeof entry.inputTokenLimit === "number" && entry.inputTokenLimit > 0
        ? entry.inputTokenLimit
        : undefined;
    out.push({ id, name: name || undefined, contextWindow: ctx });
  }
  return out.length > 0 ? out : null;
}

// A minimal shape so the merge helper stays decoupled from model-catalog.ts's
// ModelCatalogEntry (which imports it back would be circular).
export type CatalogEntryLike = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
};

/**
 * Join a provider's discovered IDs (source of truth for WHICH models exist)
 * against the vendored catalog (source of capability metadata that /models
 * endpoints usually omit). For a discovered ID with no vendored match — a model
 * newer than the SDK, e.g. claude-opus-5 — clone metadata from the provider's
 * richest vendored entry so the picker still shows a sane context window and
 * modalities. Retired vendored IDs simply don't appear in `discovered`, so they
 * drop out. Returns entries for this provider only.
 */
export function mergeDiscoveredForProvider(params: {
  provider: string;
  discovered: DiscoveredModel[];
  vendored: CatalogEntryLike[];
}): CatalogEntryLike[] {
  const provider = params.provider;
  const vendoredForProvider = params.vendored.filter((m) => m.provider === provider);
  const byId = new Map(vendoredForProvider.map((m) => [m.id.toLowerCase(), m]));

  // Richest vendored entry = the one with the largest context window; used as
  // the metadata template for models the SDK has never catalogued.
  const template = vendoredForProvider.reduce<CatalogEntryLike | undefined>((best, m) => {
    if (!best) {
      return m;
    }
    return (m.contextWindow ?? 0) > (best.contextWindow ?? 0) ? m : best;
  }, undefined);

  const out: CatalogEntryLike[] = [];
  const seen = new Set<string>();
  for (const model of params.discovered) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const vendored = byId.get(key);
    out.push({
      id: model.id,
      name: model.name || vendored?.name || model.id,
      provider,
      contextWindow: model.contextWindow ?? vendored?.contextWindow ?? template?.contextWindow,
      reasoning: vendored?.reasoning ?? template?.reasoning,
      input: vendored?.input ?? template?.input,
    });
  }
  return out;
}

export type ProviderMeta = { baseUrl?: string | null; api?: string | null };

/**
 * Replace each provider's vendored catalog slice with what the provider's
 * `/models` endpoint actually serves, where we can reach it. Providers are
 * probed in parallel; any that lack an adapter, a credential, or a reachable
 * endpoint keep their vendored entries untouched. This can only make the
 * catalog more accurate — a failed probe never drops a working entry.
 */
export async function applyLiveDiscovery(params: {
  vendored: CatalogEntryLike[];
  providerMeta: Map<string, ProviderMeta>;
  resolveKey: (provider: string) => Promise<{ apiKey?: string | null } | null>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  logWarn?: (message: string) => void;
}): Promise<CatalogEntryLike[]> {
  const providers = [...new Set(params.vendored.map((m) => m.provider))].filter((provider) => {
    const meta = params.providerMeta.get(provider);
    return adapterForApi(meta?.api) !== null;
  });

  // provider -> replacement entries (only set when discovery succeeded).
  const replacements = new Map<string, CatalogEntryLike[]>();

  await Promise.all(
    providers.map(async (provider) => {
      try {
        const meta = params.providerMeta.get(provider);
        const auth = await params.resolveKey(provider);
        const apiKey = auth?.apiKey ?? null;
        if (!apiKey) {
          return;
        }
        const discovered = await discoverProviderModels(
          { provider, baseUrl: meta?.baseUrl, api: meta?.api, apiKey },
          { fetchImpl: params.fetchImpl, timeoutMs: params.timeoutMs },
        );
        if (!discovered || discovered.length === 0) {
          return;
        }
        replacements.set(
          provider,
          mergeDiscoveredForProvider({ provider, discovered, vendored: params.vendored }),
        );
      } catch (error) {
        params.logWarn?.(`live model discovery failed for ${provider}: ${String(error)}`);
      }
    }),
  );

  if (replacements.size === 0) {
    return params.vendored;
  }

  const out: CatalogEntryLike[] = [];
  for (const entry of params.vendored) {
    // Drop vendored entries for providers we rediscovered; their replacements
    // are appended once below.
    if (!replacements.has(entry.provider)) {
      out.push(entry);
    }
  }
  for (const entries of replacements.values()) {
    out.push(...entries);
  }
  return out;
}

/**
 * Discover the model IDs a provider actually serves right now. Returns null
 * (never throws) when the provider has no listable endpoint, credentials are
 * missing, or the request fails — the caller keeps its existing list.
 */
export async function discoverProviderModels(
  target: ProviderDiscoveryTarget,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number },
): Promise<DiscoveredModel[] | null> {
  const adapter = adapterForApi(target.api);
  if (!adapter) {
    return null;
  }
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) {
    return null;
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (adapter === "anthropic") {
    return discoverAnthropicStyle(target, fetchImpl, timeoutMs);
  }
  if (adapter === "openai") {
    return discoverOpenAIStyle(target, fetchImpl, timeoutMs);
  }
  return discoverGoogleStyle(target, fetchImpl, timeoutMs);
}
