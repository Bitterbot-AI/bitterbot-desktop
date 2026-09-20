/**
 * Runtime config and model capability predicates for the in-tree Anthropic
 * provider. Config keys live under `agents.defaults.anthropic`:
 *
 *   runtime: "native" | "vendored"            (default native)
 *   toolSearch: { enabled, variant }           (default enabled, bm25)
 *   runtimeStatePlacement: "auto" | "user-tail" | "system-message" (default auto)
 *
 * Capability tables (checked against platform.claude.com on 2026-09-20):
 *   tool search        Opus 4.5+, Sonnet 4.5+, Haiku 4.5, Fable, Mythos
 *   mid-conversation   Opus 4.8, Opus 5, Fable 5/5.1, Mythos 5/5.1 (not Sonnet, not Haiku)
 *   adaptive thinking  Opus 4.6+, Sonnet 4.6+, Fable, Mythos (Haiku 4.5 keeps budget_tokens)
 */

import type { BitterbotConfig } from "../../../config/config.js";
import type { ModelAuthMode } from "../../model-auth.js";
import type {
  AnthropicRuntime,
  AnthropicRuntimeConfig,
  AnthropicRuntimeStatePlacement,
  AnthropicToolSearchVariant,
} from "./types.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_DEFAULT_RUNTIME: AnthropicRuntime = "native";
export const ANTHROPIC_DEFAULT_TOOL_SEARCH_VARIANT: AnthropicToolSearchVariant = "bm25";
export const ANTHROPIC_DEFAULT_RUNTIME_STATE_PLACEMENT: AnthropicRuntimeStatePlacement = "auto";

export function resolveAnthropicRuntimeConfig(
  cfg: BitterbotConfig | undefined,
): AnthropicRuntimeConfig {
  const raw = cfg?.agents?.defaults?.anthropic;
  const runtime: AnthropicRuntime = raw?.runtime === "vendored" ? "vendored" : "native";
  const variant: AnthropicToolSearchVariant =
    raw?.toolSearch?.variant === "regex" ? "regex" : ANTHROPIC_DEFAULT_TOOL_SEARCH_VARIANT;
  const placement: AnthropicRuntimeStatePlacement =
    raw?.runtimeStatePlacement === "user-tail" || raw?.runtimeStatePlacement === "system-message"
      ? raw.runtimeStatePlacement
      : ANTHROPIC_DEFAULT_RUNTIME_STATE_PLACEMENT;
  return {
    runtime,
    toolSearch: { enabled: raw?.toolSearch?.enabled !== false, variant },
    runtimeStatePlacement: placement,
  };
}

/** Lowercase, dots to dashes, so `claude-opus-4.8` and `claude-opus-4-8` compare equal. */
export function normalizeAnthropicModelId(modelId: string | undefined | null): string {
  return (modelId ?? "").trim().toLowerCase().replace(/\./g, "-");
}

const FABLE_OR_MYTHOS = /claude-(fable|mythos)-[0-9]/;

export function modelSupportsToolSearch(modelId: string | undefined | null): boolean {
  const id = normalizeAnthropicModelId(modelId);
  return (
    /claude-(opus|sonnet)-(4-[5-9]|[5-9])(?![0-9])/.test(id) ||
    /claude-haiku-(4-[5-9]|[5-9])(?![0-9])/.test(id) ||
    FABLE_OR_MYTHOS.test(id)
  );
}

export function modelSupportsMidConversationSystem(modelId: string | undefined | null): boolean {
  const id = normalizeAnthropicModelId(modelId);
  return /claude-opus-(4-[89]|[5-9])(?![0-9])/.test(id) || FABLE_OR_MYTHOS.test(id);
}

/**
 * Vendored pi-ai only knows Opus 4.6; every later model rejects `budget_tokens`
 * with a 400, so the native runtime treats 4.6+ (Opus and Sonnet), Fable and
 * Mythos as adaptive. Haiku 4.5 and older stay on budget-based thinking.
 */
export function modelSupportsAdaptiveThinking(modelId: string | undefined | null): boolean {
  const id = normalizeAnthropicModelId(modelId);
  return /claude-(opus|sonnet)-(4-[6-9]|[5-9])(?![0-9])/.test(id) || FABLE_OR_MYTHOS.test(id);
}

export function isAnthropicFirstPartyBaseUrl(baseUrl: unknown): boolean {
  // Absent/empty = SDK default (api.anthropic.com) = first-party.
  if (baseUrl === undefined || baseUrl === null) {
    return true;
  }
  return (
    typeof baseUrl === "string" && (baseUrl.trim() === "" || baseUrl.includes("api.anthropic.com"))
  );
}

/** Base URL the provider will use, resolved from config the same way the model registry does. */
export function resolveAnthropicProviderBaseUrl(
  cfg: BitterbotConfig | undefined,
  provider: string | undefined,
): string {
  const configured = provider ? cfg?.models?.providers?.[provider]?.baseUrl : undefined;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : ANTHROPIC_DEFAULT_BASE_URL;
}

/**
 * Whether the tool registry should be exposed with native deferral flags
 * (all tools, hot ones loaded, the rest `defer_loading: true`) instead of the
 * list_tools/use_tool dispatcher. Decided once per run from config + model,
 * with the same predicate the provider applies at request time. OAuth
 * (Claude Code identity) is excluded until tool search is verified on it.
 */
export function isNativeToolSearchActive(params: {
  config: BitterbotConfig | undefined;
  provider: string | undefined;
  modelId: string | undefined;
  authMode?: ModelAuthMode;
  baseUrl?: string;
}): boolean {
  if ((params.provider ?? "").trim().toLowerCase() !== "anthropic") {
    return false;
  }
  const runtime = resolveAnthropicRuntimeConfig(params.config);
  if (runtime.runtime !== "native" || !runtime.toolSearch.enabled) {
    return false;
  }
  if (params.authMode === "oauth") {
    return false;
  }
  if (!modelSupportsToolSearch(params.modelId)) {
    return false;
  }
  const baseUrl = params.baseUrl ?? resolveAnthropicProviderBaseUrl(params.config, params.provider);
  return isAnthropicFirstPartyBaseUrl(baseUrl);
}

/** Placement actually used for one request, given config, model, and prior 400s. */
export function resolveRuntimeStatePlacementForModel(params: {
  placement: AnthropicRuntimeStatePlacement;
  modelId: string;
  systemMessageRejected: ReadonlySet<string>;
}): "user-tail" | "system-message" {
  if (params.placement === "user-tail") {
    return "user-tail";
  }
  if (params.systemMessageRejected.has(normalizeAnthropicModelId(params.modelId))) {
    return "user-tail";
  }
  if (params.placement === "system-message") {
    return "system-message";
  }
  return modelSupportsMidConversationSystem(params.modelId) ? "system-message" : "user-tail";
}
