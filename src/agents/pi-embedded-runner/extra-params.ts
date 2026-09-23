import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { BitterbotConfig } from "../../config/config.js";
import { withOpenRouterAttribution } from "../openrouter-attribution.js";
import {
  createAnthropicStreamFn,
  resolveAnthropicRuntimeConfig,
} from "../providers/anthropic/index.js";
import {
  type AnthropicCacheRetention,
  createAnthropicCacheLayoutWrapper,
} from "./anthropic-payload-cache.js";
import { log } from "./logger.js";

// NOTE: We only force `store=true` for *direct* OpenAI Responses.
// Codex responses (chatgpt.com/backend-api/codex/responses) require `store=false`.
const OPENAI_RESPONSES_APIS = new Set(["openai-responses"]);
const OPENAI_RESPONSES_PROVIDERS = new Set(["openai"]);

/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export function resolveExtraParams(params: {
  cfg: BitterbotConfig | undefined;
  provider: string;
  modelId: string;
}): Record<string, unknown> | undefined {
  const modelKey = `${params.provider}/${params.modelId}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params ? { ...modelConfig.params } : undefined;
}

type CacheRetention = AnthropicCacheRetention;
type CacheRetentionStreamOptions = Partial<SimpleStreamOptions> & {
  cacheRetention?: CacheRetention;
};

/**
 * Resolve cacheRetention from extraParams, supporting both new `cacheRetention`
 * and legacy `cacheControlTtl` values for backwards compatibility.
 *
 * Mapping: "5m" → "short", "1h" → "long"
 *
 * Only applies to Anthropic provider (OpenRouter uses openai-completions API
 * with hardcoded cache_control, not the cacheRetention stream option).
 */
function resolveCacheRetention(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): CacheRetention | undefined {
  if (provider !== "anthropic") {
    return undefined;
  }

  // Prefer new cacheRetention if present
  const newVal = extraParams?.cacheRetention;
  if (newVal === "none" || newVal === "short" || newVal === "long") {
    return newVal;
  }

  // Fall back to legacy cacheControlTtl with mapping
  const legacy = extraParams?.cacheControlTtl;
  if (legacy === "5m") {
    return "short";
  }
  if (legacy === "1h") {
    return "long";
  }
  return undefined;
}

/**
 * PLAN-50 Phase 5: the prompt-cache TTL a run will use, for cost attribution (Anthropic bills
 * 1-hour cache writes at 2x input vs 1.25x for 5-minute writes). Only Anthropic exposes a TTL.
 */
export function resolveCacheTtlLabel(params: {
  cfg: BitterbotConfig | undefined;
  provider: string;
  modelId: string;
  baseUrl?: string;
}): "5m" | "1h" | "none" | undefined {
  if (params.provider !== "anthropic") {
    return undefined;
  }
  const envRetention = process.env.PI_CACHE_RETENTION;
  const retention =
    resolveCacheRetention(
      resolveExtraParams({ cfg: params.cfg, provider: params.provider, modelId: params.modelId }),
      params.provider,
    ) ??
    (envRetention === "none" || envRetention === "short" || envRetention === "long"
      ? envRetention
      : "short");
  if (retention === "none") {
    return "none";
  }
  if (
    retention === "long" &&
    (params.baseUrl ?? "api.anthropic.com").includes("api.anthropic.com")
  ) {
    return "1h";
  }
  return "5m";
}

function createStreamFnWithExtraParams(
  baseStreamFn: StreamFn | undefined,
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): StreamFn | undefined {
  if (!extraParams || Object.keys(extraParams).length === 0) {
    return undefined;
  }

  const streamParams: CacheRetentionStreamOptions = {};
  if (typeof extraParams.temperature === "number") {
    streamParams.temperature = extraParams.temperature;
  }
  if (typeof extraParams.maxTokens === "number") {
    streamParams.maxTokens = extraParams.maxTokens;
  }
  const cacheRetention = resolveCacheRetention(extraParams, provider);
  if (cacheRetention) {
    streamParams.cacheRetention = cacheRetention;
  }

  if (Object.keys(streamParams).length === 0) {
    return undefined;
  }

  log.debug(`creating streamFn wrapper with params: ${JSON.stringify(streamParams)}`);

  const underlying = baseStreamFn ?? streamSimple;
  const wrappedStreamFn: StreamFn = (model, context, options) =>
    underlying(model, context, {
      ...streamParams,
      ...options,
    });

  return wrappedStreamFn;
}

function isDirectOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "chatgpt.com";
  } catch {
    const normalized = baseUrl.toLowerCase();
    return normalized.includes("api.openai.com") || normalized.includes("chatgpt.com");
  }
}

function shouldForceResponsesStore(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  if (typeof model.api !== "string" || typeof model.provider !== "string") {
    return false;
  }
  if (!OPENAI_RESPONSES_APIS.has(model.api)) {
    return false;
  }
  if (!OPENAI_RESPONSES_PROVIDERS.has(model.provider)) {
    return false;
  }
  return isDirectOpenAIBaseUrl(model.baseUrl);
}

function createOpenAIResponsesStoreWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!shouldForceResponsesStore(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          (payload as { store?: unknown }).store = true;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}

/**
 * Create a streamFn wrapper that adds OpenRouter app attribution headers
 * (src/agents/openrouter-attribution.ts) whenever the request is served by
 * OpenRouter, by provider id or by base URL (custom providers pointed at it).
 */
function createOpenRouterHeadersWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      headers: withOpenRouterAttribution(model, options?.headers),
    });
}

/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export function applyExtraParamsToAgent(
  agent: { streamFn?: StreamFn },
  cfg: BitterbotConfig | undefined,
  provider: string,
  modelId: string,
  extraParamsOverride?: Record<string, unknown>,
): void {
  const extraParams = resolveExtraParams({
    cfg,
    provider,
    modelId,
  });
  const override =
    extraParamsOverride && Object.keys(extraParamsOverride).length > 0
      ? Object.fromEntries(
          Object.entries(extraParamsOverride).filter(([, value]) => value !== undefined),
        )
      : undefined;
  const merged = Object.assign({}, extraParams, override);

  // In-tree Anthropic runtime (default). Installed at the BOTTOM of the chain
  // so the extra-params / OpenRouter / Responses wrappers above it keep
  // working unchanged; it delegates every non-`anthropic-messages` model to
  // whatever was there before (pi-ai's streamSimple). `runtime: "vendored"`
  // leaves the chain exactly as it was.
  const anthropicRuntime =
    provider === "anthropic" ? resolveAnthropicRuntimeConfig(cfg) : undefined;
  if (anthropicRuntime?.runtime === "native") {
    log.debug(`installing in-tree Anthropic runtime for ${provider}/${modelId}`);
    agent.streamFn = createAnthropicStreamFn(cfg, { fallback: agent.streamFn });
  }

  const wrappedStreamFn = createStreamFnWithExtraParams(agent.streamFn, merged, provider);

  if (wrappedStreamFn) {
    log.debug(`applying extraParams to agent streamFn for ${provider}/${modelId}`);
    agent.streamFn = wrappedStreamFn;
  }

  // Per-request check: covers the "openrouter" provider and any custom
  // provider whose base URL is OpenRouter; a no-op for everything else.
  agent.streamFn = createOpenRouterHeadersWrapper(agent.streamFn);

  // Work around upstream pi-ai hardcoding `store: false` for Responses API.
  // Force `store=true` for direct OpenAI/OpenAI Codex providers so multi-turn
  // server-side conversation state is preserved.
  agent.streamFn = createOpenAIResponsesStoreWrapper(agent.streamFn);

  // Token-efficiency W4: Anthropic prompt-cache layout (tools sorted + marked,
  // system split at the cache boundary into cached/uncached blocks). The
  // retention mirrors what pi-ai itself resolves (config, then
  // PI_CACHE_RETENTION=long, then "short") so every marker carries one TTL.
  // Vendored runtime only: the native provider applies the same layout
  // function directly (with deferred-tool and system-message awareness).
  if (provider === "anthropic" && anthropicRuntime?.runtime !== "native") {
    const retention =
      resolveCacheRetention(merged, provider) ??
      (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
    log.debug(`applying Anthropic cache layout (${retention}) for ${provider}/${modelId}`);
    agent.streamFn = createAnthropicCacheLayoutWrapper(agent.streamFn, retention);
  }
}
