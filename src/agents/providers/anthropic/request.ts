/**
 * Request building. Everything the vendored pi-ai 0.52.12 provider does
 * (`buildParams`, `convertMessages`, `convertTools`, thinking/effort mapping,
 * the two cache markers on the system block and the last user message) with
 * the same key order, so the request body is byte-identical when tool search
 * is off and the runtime-state placement is `user-tail`. Additions:
 *
 *   - tools: `defer_loading: true` on deferred tools + the search tool
 *   - messages: `server_tool_use` / `tool_search_tool_result` replay
 *   - thinking: adaptive for every 4.6+ model (vendored only knew Opus 4.6)
 */

import type { Context, Message, Model, ThinkingLevel, Tool } from "@mariozechner/pi-ai";
import { transformMessages } from "@mariozechner/pi-ai/dist/providers/transform-messages.js";
import { sanitizeSurrogates } from "@mariozechner/pi-ai/dist/utils/sanitize-unicode.js";
import type {
  AnthropicEffort,
  AnthropicProviderOptions,
  AnthropicRequestParams,
  WireCacheControl,
  WireMessage,
  WireSystemBlock,
  WireTool,
  WireToolSearchTool,
} from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { toClaudeCodeName } from "./client.js";
import { modelSupportsAdaptiveThinking } from "./config.js";
import {
  filterToolReferences,
  isServerToolUseBlock,
  isToolSearchResultBlock,
  type ToolDeferralPlan,
} from "./tool-search.js";

const log = createSubsystemLogger("agents/providers/anthropic");

export type CacheRetention = "none" | "short" | "long";

/** Vendored `resolveCacheRetention`: option, then PI_CACHE_RETENTION=long, then short. */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.PI_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}

/** Vendored `getCacheControl`: 1h only for `long` against api.anthropic.com. */
export function getCacheControl(
  baseUrl: string,
  cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: WireCacheControl } {
  const retention = resolveCacheRetention(cacheRetention);
  if (retention === "none") {
    return { retention };
  }
  const ttl = retention === "long" && baseUrl.includes("api.anthropic.com") ? "1h" : undefined;
  return { retention, cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}

export function mapThinkingLevelToEffort(level: ThinkingLevel): AnthropicEffort {
  switch (level) {
    case "minimal":
      return "low";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "max";
    default:
      return "high";
  }
}

/** Vendored `adjustMaxTokensForThinking` (simple-options.js). */
export function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: Partial<Record<"minimal" | "low" | "medium" | "high", number>>,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  const budgets = { ...defaultBudgets, ...customBudgets };
  const minOutputTokens = 1024;
  const level = reasoningLevel === "xhigh" ? "high" : reasoningLevel;
  let thinkingBudget = budgets[level] ?? defaultBudgets.high;
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }
  return { maxTokens, thinkingBudget };
}

/** Vendored `streamSimpleAnthropic` option derivation (buildBaseOptions + thinking). */
export function resolveProviderOptions(
  model: Model<"anthropic-messages">,
  options:
    | (AnthropicProviderOptions & {
        reasoning?: ThinkingLevel;
        thinkingBudgets?: Partial<Record<"minimal" | "low" | "medium" | "high", number>>;
      })
    | undefined,
  apiKey: string,
): AnthropicProviderOptions {
  const base: AnthropicProviderOptions = {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
    metadata: options?.metadata,
  };
  if (!options?.reasoning) {
    return { ...base, thinkingEnabled: false };
  }
  if (modelSupportsAdaptiveThinking(model.id)) {
    return { ...base, thinkingEnabled: true, effort: mapThinkingLevelToEffort(options.reasoning) };
  }
  const adjusted = adjustMaxTokensForThinking(
    base.maxTokens || 0,
    model.maxTokens,
    options.reasoning,
    options.thinkingBudgets,
  );
  return {
    ...base,
    maxTokens: adjusted.maxTokens,
    thinkingEnabled: true,
    thinkingBudgetTokens: adjusted.thinkingBudget,
  };
}

// Normalize tool call IDs to match Anthropic's required pattern and length.
function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** Vendored `convertContentBlocks` (tool results). */
function convertContentBlocks(content: ContentPart[]): string | Record<string, unknown>[] {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
  }
  const blocks: Record<string, unknown>[] = content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: sanitizeSurrogates(block.text) };
    }
    return {
      type: "image",
      source: { type: "base64", media_type: block.mimeType, data: block.data },
    };
  });
  const hasText = blocks.some((b) => b.type === "text");
  if (!hasText) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}

export type ConvertMessagesOptions = {
  /** Search tool present in this request; when false, search blocks are not replayed. */
  searchToolPresent: boolean;
  /** Tool names in this request's `tools`; unknown `tool_reference`s are dropped. */
  knownToolNames: ReadonlySet<string>;
};

/**
 * Vendored `convertMessages` plus the two search block types. Unknown block
 * types are still skipped (vendored behavior); search blocks are replayed
 * only when the search tool is in the request.
 */
export function convertMessages(
  messages: Message[],
  model: Model<"anthropic-messages">,
  isOAuthToken: boolean,
  cacheControl: WireCacheControl | undefined,
  opts: ConvertMessagesOptions,
): WireMessage[] {
  const params: WireMessage[] = [];
  const transformedMessages = transformMessages(messages, model, normalizeToolCallId);
  const droppedRefs: string[] = [];
  for (let i = 0; i < transformedMessages.length; i++) {
    const msg = transformedMessages[i]!;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim().length > 0) {
          params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
        }
      } else {
        const blocks: Record<string, unknown>[] = msg.content.map((item) => {
          if (item.type === "text") {
            return { type: "text", text: sanitizeSurrogates(item.text) };
          }
          return {
            type: "image",
            source: { type: "base64", media_type: item.mimeType, data: item.data },
          };
        });
        let filteredBlocks = !model?.input.includes("image")
          ? blocks.filter((b) => b.type !== "image")
          : blocks;
        filteredBlocks = filteredBlocks.filter((b) =>
          b.type === "text" ? (b.text as string).trim().length > 0 : true,
        );
        if (filteredBlocks.length === 0) {
          continue;
        }
        params.push({ role: "user", content: filteredBlocks } as unknown as WireMessage);
      }
    } else if (msg.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      for (const block of msg.content as unknown[]) {
        const rec = block as { type?: string } & Record<string, unknown>;
        if (rec.type === "text") {
          const text = rec.text as string;
          if (text.trim().length === 0) {
            continue;
          }
          blocks.push({ type: "text", text: sanitizeSurrogates(text) });
        } else if (rec.type === "thinking") {
          const thinking = rec.thinking as string;
          if (thinking.trim().length === 0) {
            continue;
          }
          const signature = rec.thinkingSignature as string | undefined;
          // Missing signature (aborted stream): plain text so the API accepts it.
          if (!signature || signature.trim().length === 0) {
            blocks.push({ type: "text", text: sanitizeSurrogates(thinking) });
          } else {
            blocks.push({ type: "thinking", thinking: sanitizeSurrogates(thinking), signature });
          }
        } else if (rec.type === "toolCall") {
          const name = rec.name as string;
          blocks.push({
            type: "tool_use",
            id: rec.id,
            name: isOAuthToken ? toClaudeCodeName(name) : name,
            input: rec.arguments ?? {},
          });
        } else if (isServerToolUseBlock(block)) {
          if (!opts.searchToolPresent) {
            continue;
          }
          blocks.push({
            type: "server_tool_use",
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
        } else if (isToolSearchResultBlock(block)) {
          if (!opts.searchToolPresent) {
            continue;
          }
          const filtered = filterToolReferences(block.content, opts.knownToolNames);
          droppedRefs.push(...filtered.dropped);
          blocks.push({
            type: "tool_search_tool_result",
            tool_use_id: block.toolUseId,
            content: filtered.content,
          });
        }
      }
      if (blocks.length === 0) {
        continue;
      }
      params.push({ role: "assistant", content: blocks } as unknown as WireMessage);
    } else if (msg.role === "toolResult") {
      const toolResults: Record<string, unknown>[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content as ContentPart[]),
        is_error: msg.isError,
      });
      let j = i + 1;
      while (j < transformedMessages.length && transformedMessages[j]!.role === "toolResult") {
        const nextMsg = transformedMessages[j] as Extract<Message, { role: "toolResult" }>;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content as ContentPart[]),
          is_error: nextMsg.isError,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults } as unknown as WireMessage);
    }
  }
  if (droppedRefs.length > 0) {
    log.warn(
      `dropped tool_reference(s) no longer registered: ${[...new Set(droppedRefs)].join(", ")}`,
    );
  }
  // Add cache_control to the last user message to cache conversation history.
  if (cacheControl && params.length > 0) {
    const lastMessage = params[params.length - 1] as {
      role: string;
      content: string | Record<string, unknown>[];
    };
    if (lastMessage.role === "user") {
      if (Array.isArray(lastMessage.content)) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1];
        if (
          lastBlock &&
          (lastBlock.type === "text" ||
            lastBlock.type === "image" ||
            lastBlock.type === "tool_result")
        ) {
          lastBlock.cache_control = cacheControl;
        }
      } else if (typeof lastMessage.content === "string") {
        lastMessage.content = [
          { type: "text", text: lastMessage.content, cache_control: cacheControl },
        ];
      }
    }
  }
  return params;
}

/** Vendored `convertTools` plus `defer_loading` and the search tool (appended last). */
export function convertTools(
  tools: readonly Tool[] | undefined,
  isOAuthToken: boolean,
  plan: ToolDeferralPlan,
): Array<WireTool | WireToolSearchTool> {
  if (!tools) {
    return [];
  }
  const defs: Array<WireTool | WireToolSearchTool> = tools.map((tool) => {
    const jsonSchema = tool.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    const def: WireTool = {
      name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || [],
      },
    };
    if (plan.deferred.has(tool.name)) {
      def.defer_loading = true;
    }
    return def;
  });
  if (plan.searchTool) {
    defs.push({ ...plan.searchTool });
  }
  return defs;
}

export type BuildParamsExtras = {
  plan: ToolDeferralPlan;
  cacheControl: WireCacheControl | undefined;
};

/** Vendored `buildParams`, same key order. Cache layout is applied afterwards by the caller. */
export function buildParams(
  model: Model<"anthropic-messages">,
  context: Context,
  isOAuthToken: boolean,
  options: AnthropicProviderOptions | undefined,
  extras: BuildParamsExtras,
): AnthropicRequestParams {
  const { cacheControl } = extras;
  const knownToolNames = new Set((context.tools ?? []).map((tool) => tool.name));
  const params: AnthropicRequestParams = {
    model: model.id,
    messages: convertMessages(context.messages, model, isOAuthToken, cacheControl, {
      searchToolPresent: !!extras.plan.searchTool,
      knownToolNames,
    }),
    max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
    stream: true,
  };
  if (isOAuthToken) {
    const system: WireSystemBlock[] = [
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
    if (context.systemPrompt) {
      system.push({
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      });
    }
    params.system = system;
  } else if (context.systemPrompt) {
    params.system = [
      {
        type: "text",
        text: sanitizeSurrogates(context.systemPrompt),
        ...(cacheControl ? { cache_control: cacheControl } : {}),
      },
    ];
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }
  if (context.tools) {
    params.tools = convertTools(context.tools, isOAuthToken, extras.plan);
  }
  if (options?.thinkingEnabled && model.reasoning) {
    if (modelSupportsAdaptiveThinking(model.id)) {
      params.thinking = { type: "adaptive" };
      if (options.effort) {
        params.output_config = { effort: options.effort };
      }
    } else {
      params.thinking = { type: "enabled", budget_tokens: options.thinkingBudgetTokens || 1024 };
    }
  }
  if (options?.metadata) {
    const userId = options.metadata.user_id;
    if (typeof userId === "string") {
      params.metadata = { user_id: userId };
    }
  }
  if (options?.toolChoice) {
    params.tool_choice =
      typeof options.toolChoice === "string" ? { type: options.toolChoice } : options.toolChoice;
  }
  return params;
}
