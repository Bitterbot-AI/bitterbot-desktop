import type { BitterbotConfig } from "../config/config.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { normalizeProviderId } from "./model-selection.js";

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Live credential probes shared by the onboarding wizard and the
 * models.auth.* gateway RPCs. A probe hits the provider's cheapest
 * authenticated endpoint (the model listing) so keys can be verified
 * before they are saved, without consuming tokens.
 *
 * The probe deliberately never logs or returns the key it was given.
 */
export type AuthProbeResult = {
  ok: boolean;
  /** HTTP status when the endpoint answered. */
  status?: number;
  /** Human-readable failure detail (never contains the key). */
  error?: string;
  /** True when this provider has no probe recipe; saving is still allowed. */
  unsupported?: boolean;
};

type ProbeStyle = "openai" | "anthropic";

/**
 * Built-in base URLs for providers whose keys can be probed directly.
 * OpenAI-compatible providers all expose GET {base}/models with a Bearer
 * header; Anthropic exposes GET /v1/models with x-api-key.
 */
const PROVIDER_PROBE_RECIPES: Record<string, { baseUrl: string; style: ProbeStyle }> = {
  anthropic: { baseUrl: "https://api.anthropic.com/v1", style: "anthropic" },
  openai: { baseUrl: "https://api.openai.com/v1", style: "openai" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", style: "openai" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", style: "openai" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", style: "openai" },
  xai: { baseUrl: "https://api.x.ai/v1", style: "openai" },
  together: { baseUrl: "https://api.together.xyz/v1", style: "openai" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", style: "openai" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", style: "openai" },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", style: "openai" },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    style: "openai",
  },
};

function buildProbeHeaders(style: ProbeStyle, apiKey: string): Record<string, string> {
  if (style === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function joinModelsEndpoint(baseUrl: string): string {
  return new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
}

export function resolveProbeRecipe(params: {
  provider: string;
  cfg?: BitterbotConfig;
  baseUrl?: string;
}): { baseUrl: string; style: ProbeStyle } | null {
  const provider = normalizeProviderId(params.provider);
  const configured = params.cfg?.models?.providers?.[provider];
  const explicitBase = params.baseUrl?.trim() || configured?.baseUrl?.trim();
  if (explicitBase) {
    const style: ProbeStyle = configured?.api === "anthropic-messages" ? "anthropic" : "openai";
    return { baseUrl: explicitBase, style };
  }
  return PROVIDER_PROBE_RECIPES[provider] ?? null;
}

function describeProbeFailure(status: number): string {
  if (status === 401 || status === 403) {
    return "The provider rejected the key (unauthorized).";
  }
  if (status === 429) {
    return "The key authenticated but the provider is rate-limiting it.";
  }
  return `The provider answered with HTTP ${status}.`;
}

export async function probeProviderKey(params: {
  provider: string;
  apiKey: string;
  cfg?: BitterbotConfig;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<AuthProbeResult> {
  const recipe = resolveProbeRecipe(params);
  if (!recipe) {
    return {
      ok: false,
      unsupported: true,
      error: `No live probe available for provider "${normalizeProviderId(params.provider)}". The key can still be saved.`,
    };
  }
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    return { ok: false, error: "Empty key." };
  }
  try {
    const res = await fetchWithTimeout(
      joinModelsEndpoint(recipe.baseUrl),
      { method: "GET", headers: buildProbeHeaders(recipe.style, apiKey) },
      params.timeoutMs ?? PROBE_TIMEOUT_MS,
    );
    // Rate-limited means the credential authenticated; treat as success so a
    // busy account can still save a valid key with an honest status attached.
    if (res.status === 429) {
      return { ok: true, status: res.status, error: describeProbeFailure(res.status) };
    }
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, error: describeProbeFailure(res.status) };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The provider did not answer within the probe timeout."
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: message };
  }
}
