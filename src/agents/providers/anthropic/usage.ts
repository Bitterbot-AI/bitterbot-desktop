/**
 * Usage mapping. Same semantics as vendored pi-ai (message_start seeds every
 * counter, message_delta overwrites only the fields it carries) plus the
 * cache-write TTL split the vendored provider dropped:
 *
 *   usage.cacheWrite5m  <- usage.cache_creation.ephemeral_5m_input_tokens
 *   usage.cacheWrite1h  <- usage.cache_creation.ephemeral_1h_input_tokens
 *
 * Both are set only when the response carries `cache_creation`; proxies that
 * omit it leave them undefined so consumers can tell "0" from "unknown".
 */

import type { Model } from "@mariozechner/pi-ai";
import { calculateCost } from "@mariozechner/pi-ai";
import type { AnthropicUsage } from "./types.js";

export type RawUsageLike = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
};

export function createEmptyUsage(): AnthropicUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function applyCacheCreationSplit(usage: AnthropicUsage, raw: RawUsageLike): void {
  const split = raw.cache_creation;
  if (!split || typeof split !== "object") {
    return;
  }
  const five = finite(split.ephemeral_5m_input_tokens);
  const hour = finite(split.ephemeral_1h_input_tokens);
  if (five !== undefined) {
    usage.cacheWrite5m = five;
  }
  if (hour !== undefined) {
    usage.cacheWrite1h = hour;
  }
}

function finalize(usage: AnthropicUsage, model: Model<"anthropic-messages">): void {
  // Anthropic doesn't provide total_tokens, compute from components.
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  calculateCost(model, usage);
}

/** `message_start`: seed every counter (so an aborted stream still has input counts). */
export function applyMessageStartUsage(
  usage: AnthropicUsage,
  raw: RawUsageLike | undefined,
  model: Model<"anthropic-messages">,
): void {
  usage.input = raw?.input_tokens || 0;
  usage.output = raw?.output_tokens || 0;
  usage.cacheRead = raw?.cache_read_input_tokens || 0;
  usage.cacheWrite = raw?.cache_creation_input_tokens || 0;
  if (raw) {
    applyCacheCreationSplit(usage, raw);
  }
  finalize(usage, model);
}

/** `message_delta`: overwrite only the fields present (proxies omit input_tokens here). */
export function applyMessageDeltaUsage(
  usage: AnthropicUsage,
  raw: RawUsageLike | undefined,
  model: Model<"anthropic-messages">,
): void {
  if (raw) {
    if (raw.input_tokens != null) {
      usage.input = raw.input_tokens;
    }
    if (raw.output_tokens != null) {
      usage.output = raw.output_tokens;
    }
    if (raw.cache_read_input_tokens != null) {
      usage.cacheRead = raw.cache_read_input_tokens;
    }
    if (raw.cache_creation_input_tokens != null) {
      usage.cacheWrite = raw.cache_creation_input_tokens;
    }
    applyCacheCreationSplit(usage, raw);
  }
  finalize(usage, model);
}
