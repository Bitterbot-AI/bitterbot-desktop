/**
 * In-tree Anthropic Messages provider (replaces vendored pi-ai 0.52.12's
 * `streamSimpleAnthropic` for `anthropic-messages` models when
 * `agents.defaults.anthropic.runtime` is `native`, the default).
 *
 * Per request:
 *   1. auth + headers exactly as vendored (client.ts)
 *   2. tool deferral plan: hot set loaded, the rest `defer_loading`, search
 *      tool appended; guards against deferring everything (tool-search.ts)
 *   3. params in vendored key order (request.ts), then the cache layout
 *      (tools sorted, marker on the last NON-deferred tool, stable system
 *      block marked, volatile `<runtime-state>` after the last user marker)
 *      called directly, not through onPayload
 *   4. `<runtime-state>` placement: `role: "system"` message after the last
 *      user message on models that support it, user-tail otherwise; a 400
 *      "role 'system' is not supported" falls back to user-tail once and is
 *      remembered per model for the process lifetime
 *   5. stream consumption (stream.ts) incl. server_tool_use /
 *      tool_search_tool_result, usage with the cache-write TTL split
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import Anthropic from "@anthropic-ai/sdk";
import { getEnvApiKey, streamSimple } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import type { BitterbotConfig } from "../../../config/config.js";
import type {
  AnthropicRuntimeConfig,
  AnthropicTransport,
  AnthropicTransportResult,
} from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { applyAnthropicCacheLayout } from "../../pi-embedded-runner/anthropic-payload-cache.js";
import {
  buildCopilotDynamicHeaders,
  hasCopilotVisionInput,
  resolveClientOptions,
} from "./client.js";
import {
  isAnthropicFirstPartyBaseUrl,
  modelSupportsToolSearch,
  normalizeAnthropicModelId,
  resolveAnthropicRuntimeConfig,
  resolveRuntimeStatePlacementForModel,
} from "./config.js";
import { buildParams, getCacheControl, resolveProviderOptions } from "./request.js";
import { consumeAnthropicMessage, consumeAnthropicStream } from "./stream.js";
import { collectToolSearchHistoryState, planToolDeferral } from "./tool-search.js";
import { createEmptyUsage } from "./usage.js";

export * from "./config.js";
export * from "./tool-search.js";
export * from "./types.js";
export { mapStopReason, messageToEvents } from "./stream.js";
export { buildParams, convertMessages, convertTools, getCacheControl } from "./request.js";
export { resolveClientOptions } from "./client.js";

const log = createSubsystemLogger("agents/providers/anthropic");

/** Deferred tools the API rejected this process, per model: un-deferred from then on (on-demand rescue). */
const forceLoadedToolsByModel = new Map<string, Set<string>>();

/**
 * A 400 that names a deferred tool (e.g. a history `tool_use` the API will
 * not accept for a deferred definition). Returns the deferred names found in
 * the error text, or every deferred tool called in history when the text
 * names none (last resort, still only after a real rejection).
 */
export function deferredToolsRejected(
  err: unknown,
  deferred: ReadonlySet<string>,
  calledInHistory: ReadonlySet<string>,
): string[] {
  const status = (err as { status?: unknown } | null)?.status;
  if (status !== 400 && !(err instanceof Anthropic.BadRequestError)) {
    return [];
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? "");
  if (!/tool/i.test(message)) {
    return [];
  }
  const named = [...deferred].filter((name) => message.includes(name));
  if (named.length > 0) {
    return named;
  }
  if (/defer|not found|unknown tool|does not exist|invalid tool/i.test(message)) {
    return [...deferred].filter((name) => calledInHistory.has(name));
  }
  return [];
}

/** Models that returned 400 for a `role: "system"` message this process; user-tail from then on. */
const systemMessageRejected = new Set<string>();

/** @internal tests */
export function resetAnthropicRuntimeState(): void {
  forceLoadedToolsByModel.clear();
  systemMessageRejected.clear();
}

export function isSystemRoleRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? "");
  if (status !== 400 && !(err instanceof Anthropic.BadRequestError)) {
    return false;
  }
  return /role\s*['"]?system['"]?/i.test(message) || /system.*not supported/i.test(message);
}

const defaultTransport: AnthropicTransport = ({ params, clientOptions, signal }) => {
  const client = new Anthropic(
    clientOptions as unknown as ConstructorParameters<typeof Anthropic>[0],
  );
  type StreamBody = Parameters<typeof client.messages.stream>[0];
  return client.messages.stream({ ...params, stream: true } as unknown as StreamBody, { signal });
};

export type AnthropicStreamFnDeps = {
  /** Handles every model whose api is not `anthropic-messages` (default: pi-ai streamSimple). */
  fallback?: StreamFn;
  /** Request executor; tests inject synthetic event streams here. */
  transport?: AnthropicTransport;
  /** Override the config-derived runtime settings (tests). */
  runtimeConfig?: AnthropicRuntimeConfig;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

/**
 * Same signature and semantics as vendored `streamSimpleAnthropic`: the API
 * key is resolved from options or the environment and a missing key throws
 * synchronously.
 */
export function streamAnthropicNative(
  model: Model<"anthropic-messages">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  deps: { runtimeCfg: AnthropicRuntimeConfig; transport: AnthropicTransport },
): AssistantMessageEventStream {
  const resolvedKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!resolvedKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const providerOptions = resolveProviderOptions(model, options, resolvedKey);
  const stream = new AssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: createEmptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let started = false;
    try {
      const apiKey = providerOptions.apiKey ?? "";
      const copilotHeaders =
        model.provider === "github-copilot"
          ? buildCopilotDynamicHeaders({
              messages: context.messages,
              hasImages: hasCopilotVisionInput(context.messages),
            })
          : undefined;
      const { clientOptions, isOAuthToken } = resolveClientOptions(
        model,
        apiKey,
        (options as { interleavedThinking?: boolean } | undefined)?.interleavedThinking ?? true,
        providerOptions.headers,
        copilotHeaders,
      );
      const { cacheControl } = getCacheControl(model.baseUrl, providerOptions.cacheRetention);
      // An absent baseUrl means the SDK default (api.anthropic.com): first-party.
      const firstParty =
        typeof model.baseUrl !== "string" || model.baseUrl.trim().length === 0
          ? true
          : isAnthropicFirstPartyBaseUrl(model.baseUrl);
      const searchOffReason = !deps.runtimeCfg.toolSearch.enabled
        ? "config"
        : isOAuthToken
          ? "oauth"
          : !firstParty
            ? "baseUrl"
            : !modelSupportsToolSearch(model.id)
              ? "model"
              : undefined;
      const searchEnabled = searchOffReason === undefined;
      const history = collectToolSearchHistoryState(context.messages);
      const modelKey = normalizeAnthropicModelId(model.id);
      const forceLoaded = forceLoadedToolsByModel.get(modelKey) ?? new Set<string>();
      let plan = planToolDeferral({
        tools: context.tools ?? [],
        searchEnabled,
        variant: deps.runtimeCfg.toolSearch.variant,
        history,
        forceLoaded,
      });
      let rescueAttempted = false;
      if (plan.guardTripped) {
        log.warn("tool search: every tool was flagged deferred; loading all schemas instead");
      }
      if (plan.rescued.length > 0) {
        log.info(
          `tool search: tools un-deferred after an earlier API rejection: ${plan.rescued.join(", ")}`,
        );
      }
      let placement = resolveRuntimeStatePlacementForModel({
        placement: deps.runtimeCfg.runtimeStatePlacement,
        modelId: model.id,
        systemMessageRejected,
      });
      const consumerCtx = { output, stream, model, isOAuthToken, tools: context.tools };
      for (;;) {
        const params = buildParams(model, context, isOAuthToken, providerOptions, {
          plan,
          cacheControl,
        });
        const layout = applyAnthropicCacheLayout(params, cacheControl, {
          volatilePlacement: placement,
        });
        if (layout) {
          log.debug(
            `request: tools=${layout.toolCount} deferred=${plan.deferred.size} search=${plan.searchTool?.name ?? `off(${searchOffReason ?? "no-deferred-tools"})`} markers=${layout.markerCount} volatile=${layout.volatileSystemChars}c@${layout.volatilePlacement}`,
          );
        }
        providerOptions.onPayload?.(params);
        try {
          const result: AnthropicTransportResult = await deps.transport({
            params,
            clientOptions,
            signal: providerOptions.signal,
          });
          if (!started) {
            started = true;
            stream.push({ type: "start", partial: output });
          }
          if (isAsyncIterable(result)) {
            await consumeAnthropicStream(
              result as AsyncIterable<Anthropic.RawMessageStreamEvent>,
              consumerCtx,
            );
          } else {
            consumeAnthropicMessage(result, consumerCtx);
          }
          break;
        } catch (err) {
          if (output.content.length === 0 && !rescueAttempted) {
            const rejected = deferredToolsRejected(err, plan.deferred, history.called);
            if (rejected.length > 0) {
              rescueAttempted = true;
              for (const name of rejected) {
                forceLoaded.add(name);
              }
              forceLoadedToolsByModel.set(modelKey, forceLoaded);
              plan = planToolDeferral({
                tools: context.tools ?? [],
                searchEnabled,
                variant: deps.runtimeCfg.toolSearch.variant,
                history,
                forceLoaded,
              });
              log.warn(
                `tool search: API rejected deferred tool(s) ${rejected.join(", ")}; un-deferring for this model from now on`,
              );
              continue;
            }
          }
          if (
            placement === "system-message" &&
            output.content.length === 0 &&
            isSystemRoleRejection(err)
          ) {
            systemMessageRejected.add(normalizeAnthropicModelId(model.id));
            placement = "user-tail";
            log.warn(
              `mid-conversation system message rejected for ${model.id}; falling back to user-tail placement`,
            );
            continue;
          }
          throw err;
        }
      }
      if (providerOptions.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content as Array<{ index?: number }>) {
        delete block.index;
      }
      output.stopReason = providerOptions.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

/**
 * pi-agent-core `StreamFn`: native provider for `anthropic-messages`, the
 * fallback (vendored `streamSimple` by default) for everything else.
 */
export function createAnthropicStreamFn(
  cfg: BitterbotConfig | undefined,
  deps?: AnthropicStreamFnDeps,
): StreamFn {
  const runtimeCfg = deps?.runtimeConfig ?? resolveAnthropicRuntimeConfig(cfg);
  const fallback: StreamFn = deps?.fallback ?? streamSimple;
  const transport = deps?.transport ?? defaultTransport;
  return (model, context, options) => {
    if (model?.api !== "anthropic-messages") {
      return fallback(model, context, options);
    }
    return streamAnthropicNative(model as Model<"anthropic-messages">, context, options, {
      runtimeCfg,
      transport,
    });
  };
}
