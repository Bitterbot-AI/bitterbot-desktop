import { type ChatMessage, type ToolCallItem, nextMsgId } from "../stores/chat-store";

/**
 * Extract displayable text from a gateway message object.
 * Gateway messages can be in various formats:
 * - Simple string
 * - { content: string }
 * - { content: [{ type: "text", text: string }, ...] }
 * - { role, content, ... }
 */
export function extractMessageText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";

  const obj = msg as Record<string, unknown>;

  // Direct content field
  const content = obj.content;
  if (typeof content === "string") return stripThinkingTags(content);

  // Array of content blocks (Anthropic/OpenAI format)
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block: unknown) => {
        const b = block as Record<string, unknown>;
        return typeof b.text === "string" ? b.text : "";
      })
      .join("");
  }

  // Fallback: try text field directly
  if (typeof obj.text === "string") return obj.text;

  return "";
}

/**
 * Extract thinking/reasoning text from a message.
 */
export function extractThinking(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const obj = msg as Record<string, unknown>;

  // Check for explicit thinking content blocks
  if (Array.isArray(obj.content)) {
    const thinkingBlocks = obj.content.filter(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "thinking",
    );
    if (thinkingBlocks.length > 0) {
      return thinkingBlocks
        .map((b: unknown) => (b as Record<string, unknown>).thinking ?? "")
        .join("\n");
    }
  }

  // Check for <think> tags in text
  const text = extractMessageText(msg);
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/);
  return thinkMatch ? thinkMatch[1]?.trim() : undefined;
}

/**
 * Strip <think>...</think> tags from display text.
 */
function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * Extract tool call blocks from a gateway message.
 * Finds `type: "tool_use"` content blocks.
 */
export function extractToolCalls(msg: unknown): ToolCallItem[] {
  if (!msg || typeof msg !== "object") return [];
  const obj = msg as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return [];

  return obj.content
    .filter(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "tool_use",
    )
    .map((block: unknown) => {
      const b = block as Record<string, unknown>;
      return {
        id: (b.id as string) ?? "",
        name: (b.name as string) ?? "unknown",
        args: b.input ?? {},
      };
    });
}

/**
 * Extract tool result from a gateway message.
 * Finds tool result content from tool-role messages.
 */
export function extractToolResult(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const obj = msg as Record<string, unknown>;
  if (obj.role !== "tool") return undefined;

  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block: unknown) => (block as Record<string, unknown>).text ?? "")
      .join("");
  }
  return undefined;
}

/**
 * Extract role from a gateway message.
 */
function extractRole(
  msg: unknown,
): "user" | "assistant" | "system" | "tool" {
  if (!msg || typeof msg !== "object") return "assistant";
  const obj = msg as Record<string, unknown>;
  const role = obj.role;
  if (role === "user") return "user";
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  return "assistant";
}

/**
 * Extract images from a message's content blocks.
 */
function extractImages(
  msg: unknown,
): Array<{ type: "base64" | "url"; mimeType?: string; data: string }> {
  if (!msg || typeof msg !== "object") return [];
  const obj = msg as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return [];

  const images: Array<{
    type: "base64" | "url";
    mimeType?: string;
    data: string;
  }> = [];

  for (const block of obj.content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;

    // Anthropic image format
    if (b.type === "image" && b.source && typeof b.source === "object") {
      const src = b.source as Record<string, unknown>;
      if (src.type === "base64" && typeof src.data === "string") {
        images.push({
          type: "base64",
          mimeType: (src.media_type as string) ?? "image/png",
          data: src.data,
        });
      }
    }

    // OpenAI image_url format
    if (b.type === "image_url" && b.image_url && typeof b.image_url === "object") {
      const img = b.image_url as Record<string, unknown>;
      if (typeof img.url === "string") {
        images.push({ type: "url", data: img.url });
      }
    }
  }

  return images;
}

/**
 * Extract usage data from a gateway message.
 */
function extractUsage(
  msg: unknown,
): { input: number; output: number; total: number } | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const obj = msg as Record<string, unknown>;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { input, output, total: input + output };
}

/**
 * Normalize a raw gateway message into our ChatMessage format.
 */
export function normalizeMessage(raw: unknown, id?: string): ChatMessage {
  const role = extractRole(raw);
  const obj = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};

  const msg: ChatMessage = {
    id: id ?? nextMsgId(),
    role,
    content: extractMessageText(raw),
    timestamp:
      typeof obj.timestamp === "number"
        ? obj.timestamp
        : Date.now(),
    thinking: extractThinking(raw),
    images: extractImages(raw),
  };

  // Attach tool calls for assistant messages
  if (role === "assistant") {
    const tcs = extractToolCalls(raw);
    if (tcs.length > 0) {
      msg.toolCalls = tcs;
    }
    const usage = extractUsage(raw);
    if (usage) {
      msg.usage = usage;
    }
    if (typeof obj.stop_reason === "string") {
      msg.stopReason = obj.stop_reason;
    }
  }

  // Attach tool_call_id for tool-role messages
  if (role === "tool" && typeof obj.tool_call_id === "string") {
    msg.toolCallId = obj.tool_call_id;
  }

  return msg;
}

/**
 * Normalize an array of raw gateway messages.
 * Filters out tool-role messages (they render in the panel) and empty messages.
 */
export function normalizeMessages(rawMessages: unknown[]): ChatMessage[] {
  return rawMessages
    .map((raw, i) => normalizeMessage(raw, `hist-${i}`))
    .filter((msg) => {
      // Filter out tool-role messages — they show in the panel, not in chat
      if (msg.role === "tool") return false;
      return msg.content.length > 0 || (msg.images && msg.images.length > 0) || (msg.toolCalls && msg.toolCalls.length > 0);
    });
}

/**
 * Parse a chat event payload from the gateway.
 */
export interface ChatEventPayload {
  runId: string;
  sessionKey: string;
  seq: number;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
}

export function parseChatEvent(payload: unknown): ChatEventPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.runId !== "string" || typeof p.state !== "string") return null;
  return {
    runId: p.runId,
    sessionKey: (p.sessionKey as string) ?? "",
    seq: typeof p.seq === "number" ? p.seq : 0,
    state: p.state as ChatEventPayload["state"],
    message: p.message,
    errorMessage: p.errorMessage as string | undefined,
    usage: p.usage,
    stopReason: p.stopReason as string | undefined,
  };
}

/**
 * Parse an agent event payload from the gateway.
 * Agent events carry tool execution data (start/update/result).
 */
export interface AgentEventPayload {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
}

export function parseAgentEvent(payload: unknown): AgentEventPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.runId !== "string") return null;
  return {
    runId: p.runId,
    seq: typeof p.seq === "number" ? p.seq : 0,
    stream: typeof p.stream === "string" ? p.stream : "",
    ts: typeof p.ts === "number" ? p.ts : Date.now(),
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    data: (p.data && typeof p.data === "object" ? p.data : {}) as Record<string, unknown>,
  };
}

/**
 * Format tool output for display. Handles string, object, and content-block formats.
 */
export function formatToolOutput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  // Try extracting text from content blocks
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      const parts = obj.content
        .filter((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          return (item as Record<string, unknown>).type === "text";
        })
        .map((item: unknown) => (item as Record<string, unknown>).text ?? "")
        .filter(Boolean);
      if (parts.length > 0) return parts.join("\n");
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
