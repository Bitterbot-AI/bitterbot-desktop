/**
 * Shared types for the in-tree Anthropic Messages provider.
 *
 * The wire types are written out here rather than taken from the SDK's
 * non-beta namespace because @anthropic-ai/sdk 0.73 (the version pi-ai pins)
 * predates `defer_loading`, the tool search tools, and `role: "system"`
 * messages on the non-beta surface. The API accepts all three without a beta
 * header; the SDK types just lag.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, StreamOptions, Usage } from "@mariozechner/pi-ai";

export type AnthropicRuntime = "native" | "vendored";
export type AnthropicToolSearchVariant = "bm25" | "regex";
export type AnthropicRuntimeStatePlacement = "auto" | "user-tail" | "system-message";

export type AnthropicRuntimeConfig = {
  /** `native` = this provider; `vendored` = pi-ai 0.52.12's provider, byte-identical to before. */
  runtime: AnthropicRuntime;
  toolSearch: {
    enabled: boolean;
    variant: AnthropicToolSearchVariant;
  };
  runtimeStatePlacement: AnthropicRuntimeStatePlacement;
};

/**
 * Usage as pi-agent-core sees it, extended additively. `cacheWrite` stays the
 * total (`cache_creation_input_tokens`); the TTL split comes from
 * `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
 * and is only set when the response carries it.
 */
export type AnthropicUsage = Usage & {
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

/** Claude's call to the server-side tool search tool (`server_tool_use` on the wire). */
export type ServerToolUseBlock = {
  type: "serverToolUse";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** The search result (`tool_search_tool_result` on the wire), kept verbatim for replay. */
export type ToolSearchResultBlock = {
  type: "toolSearchResult";
  toolUseId: string;
  /** Verbatim `content` from the API (`tool_search_tool_search_result` or `..._error`). */
  content: unknown;
  /** Tool names referenced by the result (empty on error or no match). */
  toolNames: string[];
};

export type AnthropicAssistantBlock =
  | AssistantMessage["content"][number]
  | ServerToolUseBlock
  | ToolSearchResultBlock;

export type AnthropicEffort = "low" | "medium" | "high" | "max";

/** Mirror of pi-ai's `AnthropicOptions` (kept local so the type does not drift with the vendored copy). */
export interface AnthropicProviderOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: AnthropicEffort;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

export type WireCacheControl = { type: "ephemeral"; ttl?: "1h" };

export type WireTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  defer_loading?: boolean;
  cache_control?: WireCacheControl;
};

export type WireToolSearchTool = {
  type: string;
  name: string;
  cache_control?: WireCacheControl;
};

export type WireSystemBlock = { type: "text"; text: string; cache_control?: WireCacheControl };

export type WireSystemMessage = {
  role: "system";
  content: string | WireSystemBlock[];
};

export type WireMessage = Anthropic.MessageParam | WireSystemMessage;

export type WireThinking = { type: "adaptive" } | { type: "enabled"; budget_tokens: number };

/** The request body we build; key order matters for the byte-level parity test. */
export type AnthropicRequestParams = {
  model: string;
  messages: WireMessage[];
  max_tokens: number;
  stream: boolean;
  system?: WireSystemBlock[];
  temperature?: number;
  tools?: Array<WireTool | WireToolSearchTool>;
  thinking?: WireThinking;
  output_config?: { effort: AnthropicEffort };
  metadata?: { user_id: string };
  tool_choice?: { type: string; name?: string };
};

export type AnthropicClientOptions = {
  apiKey: string | null;
  authToken?: string;
  baseURL: string;
  dangerouslyAllowBrowser: true;
  defaultHeaders: Record<string, string>;
};

export type AnthropicTransportRequest = {
  params: AnthropicRequestParams;
  clientOptions: AnthropicClientOptions;
  signal?: AbortSignal;
};

/** Either the SDK's event stream or a complete (non-streaming) message. */
export type AnthropicTransportResult =
  | AsyncIterable<Anthropic.RawMessageStreamEvent>
  | Anthropic.Message;

export type AnthropicTransport = (
  request: AnthropicTransportRequest,
) => Promise<AnthropicTransportResult> | AnthropicTransportResult;
