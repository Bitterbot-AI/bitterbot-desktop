/**
 * Helpers vendored from @mariozechner/pi-ai 0.52.12 (MIT, Mario Zechner).
 *
 * pi-ai 0.73 added a package `exports` map, so its internal
 * `dist/providers/transform-messages.js` and `dist/utils/sanitize-unicode.js`
 * modules are no longer importable. The in-tree Anthropic provider needs both,
 * so they live here, ported to TypeScript.
 *
 * transformMessages deliberately keeps the 0.52.12 behaviour this provider
 * shipped with. pi-ai 0.73 added three changes that are NOT adopted here (yet):
 * image-to-placeholder downgrade for non-vision models, dropping redacted
 * thinking across models, and a synthetic error result for a trailing
 * unanswered tool call.
 */

import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

/**
 * Removes unpaired Unicode surrogate characters from a string. Unpaired
 * surrogates break JSON serialization at most providers; properly paired
 * surrogates (emoji etc.) are preserved.
 */
export function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

/**
 * Normalize a transcript for replay against `model`: flatten thinking blocks
 * from other models, normalize tool call ids, skip errored/aborted assistant
 * turns and insert synthetic results for tool calls orphaned by a later turn.
 */
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg): Message => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }
    const assistantMsg = msg;
    const isSameModel =
      assistantMsg.provider === model.provider &&
      assistantMsg.api === model.api &&
      assistantMsg.model === model.id;
    const transformedContent = assistantMsg.content.flatMap(
      (block): AssistantMessage["content"] => {
        if (block.type === "thinking") {
          // Same model: keep signed thinking even when the text is empty.
          if (isSameModel && block.thinkingSignature) {
            return [block];
          }
          if (!block.thinking || block.thinking.trim() === "") {
            return [];
          }
          if (isSameModel) {
            return [block];
          }
          return [{ type: "text", text: block.thinking }];
        }
        if (block.type === "text") {
          if (isSameModel) {
            return [block];
          }
          return [{ type: "text", text: block.text }];
        }
        // Other block kinds (e.g. replayed server tool-search blocks) pass through.
        if ((block as { type: string }).type !== "toolCall") {
          return [block];
        }
        let normalizedToolCall: ToolCall = block;
        if (!isSameModel && block.thoughtSignature) {
          normalizedToolCall = { ...block };
          delete normalizedToolCall.thoughtSignature;
        }
        if (!isSameModel && normalizeToolCallId) {
          const normalizedId = normalizeToolCallId(block.id, model, assistantMsg);
          if (normalizedId !== block.id) {
            toolCallIdMap.set(block.id, normalizedId);
            normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
          }
        }
        return [normalizedToolCall];
      },
    );
    return { ...assistantMsg, content: transformedContent };
  });

  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length === 0) {
      return;
    }
    for (const tc of pendingToolCalls) {
      if (!existingToolResultIds.has(tc.id)) {
        const synthetic: ToolResultMessage = {
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: Date.now(),
        };
        result.push(synthetic);
      }
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const msg of transformed) {
    if (msg.role === "assistant") {
      insertSyntheticToolResults();
      // Errored/aborted turns are incomplete and must not be replayed.
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }
      result.push(msg);
    } else if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else {
      insertSyntheticToolResults();
      result.push(msg);
    }
  }
  return result;
}
