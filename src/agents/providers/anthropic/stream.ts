/**
 * Stream consumer: Anthropic SSE events -> pi-ai AssistantMessage events.
 * Vendored 0.52.12 handling for text / thinking / interleaved thinking /
 * tool_use (fine-grained JSON streaming) / usage / stop reasons, plus the
 * blocks native tool search emits:
 *
 *   server_tool_use          -> { type: "serverToolUse", id, name, input }
 *   tool_search_tool_result  -> { type: "toolSearchResult", toolUseId, content, toolNames }
 *
 * Both are stored on the assistant message (no pi-ai event is emitted for
 * them; pi-agent-core has no event type for server tools) so the next
 * request can replay them and the API can expand the references. A
 * `tool_use` of a discovered tool is an ordinary toolCall block.
 *
 * Non-streaming responses go through the same handler: `messageToEvents`
 * synthesizes the event sequence from a complete message.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage, Model, StopReason, Tool } from "@mariozechner/pi-ai";
import { type AssistantMessageEventStream, parseStreamingJson } from "@mariozechner/pi-ai";
import type { AnthropicAssistantBlock, AnthropicUsage } from "./types.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { fromClaudeCodeName } from "./client.js";
import { extractToolReferenceNames } from "./tool-search.js";
import { applyMessageDeltaUsage, applyMessageStartUsage, type RawUsageLike } from "./usage.js";

const log = createSubsystemLogger("providers/anthropic");

export type StreamConsumerContext = {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  model: Model<"anthropic-messages">;
  isOAuthToken: boolean;
  tools?: readonly Tool[];
};

/** Loose event shape: the SDK union predates `tool_search_tool_result`. */
type RawEvent = {
  type: string;
  index?: number;
  content_block?: { type: string } & Record<string, unknown>;
  delta?: { type?: string; stop_reason?: string | null } & Record<string, unknown>;
  message?: { usage?: RawUsageLike };
  usage?: RawUsageLike;
};

type IndexedBlock = AnthropicAssistantBlock & { index?: number; partialJson?: string };

export function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    case "refusal":
      return "error";
    case "pause_turn": // Stop is good enough -> resubmit
      return "stop";
    case "stop_sequence":
      return "stop"; // We don't supply stop sequences, so this should never happen
    case "sensitive": // Content flagged by safety filters (not yet in SDK types)
      return "error";
    default:
      // Handle unknown stop reasons gracefully (API may add new values)
      throw new Error(`Unhandled stop reason: ${reason}`);
  }
}

function findBlock(blocks: IndexedBlock[], index: number | undefined): number {
  return blocks.findIndex((b) => b.index === index);
}

function handleEvent(event: RawEvent, ctx: StreamConsumerContext): void {
  const { output, stream, model } = ctx;
  const blocks = output.content as IndexedBlock[];
  const usage = output.usage as AnthropicUsage;
  if (event.type === "message_start") {
    applyMessageStartUsage(usage, event.message?.usage, model);
    return;
  }
  if (event.type === "content_block_start") {
    const cb = event.content_block;
    if (!cb) {
      return;
    }
    if (cb.type === "text") {
      blocks.push({ type: "text", text: "", index: event.index });
      stream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
    } else if (cb.type === "thinking") {
      blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
      stream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
    } else if (cb.type === "tool_use") {
      const name = cb.name as string;
      blocks.push({
        type: "toolCall",
        id: cb.id as string,
        name: ctx.isOAuthToken ? fromClaudeCodeName(name, ctx.tools) : name,
        arguments: (cb.input as Record<string, unknown> | undefined) ?? {},
        partialJson: "",
        index: event.index,
      });
      stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
    } else if (cb.type === "server_tool_use") {
      log.debug(`tool search: model issued ${String(cb.name)} (server_tool_use ${String(cb.id)})`);
      blocks.push({
        type: "serverToolUse",
        id: cb.id as string,
        name: cb.name as string,
        input: (cb.input as Record<string, unknown> | undefined) ?? {},
        partialJson: "",
        index: event.index,
      });
    } else if (cb.type === "tool_search_tool_result") {
      blocks.push({
        type: "toolSearchResult",
        toolUseId: cb.tool_use_id as string,
        content: cb.content,
        toolNames: extractToolReferenceNames(cb.content),
        index: event.index,
      });
    }
    // Other server-side block types (web search, code execution) are not
    // requested by this provider and are ignored, as the vendored one did.
    return;
  }
  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (!delta) {
      return;
    }
    const index = findBlock(blocks, event.index);
    const block = blocks[index];
    if (!block) {
      return;
    }
    if (delta.type === "text_delta" && block.type === "text") {
      const text = delta.text as string;
      block.text += text;
      stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      const thinking = delta.thinking as string;
      block.thinking += thinking;
      stream.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: thinking,
        partial: output,
      });
    } else if (delta.type === "input_json_delta") {
      const partial = delta.partial_json as string;
      if (block.type === "toolCall") {
        block.partialJson = (block.partialJson ?? "") + partial;
        block.arguments = parseStreamingJson(block.partialJson);
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: partial,
          partial: output,
        });
      } else if (block.type === "serverToolUse") {
        block.partialJson = (block.partialJson ?? "") + partial;
        block.input = parseStreamingJson(block.partialJson);
      }
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature || "") + (delta.signature as string);
    }
    return;
  }
  if (event.type === "content_block_stop") {
    const index = findBlock(blocks, event.index);
    const block = blocks[index];
    if (!block) {
      return;
    }
    delete block.index;
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: output,
      });
    } else if (block.type === "toolCall") {
      block.arguments = parseStreamingJson(block.partialJson);
      delete block.partialJson;
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
    } else if (block.type === "serverToolUse") {
      if (block.partialJson) {
        block.input = parseStreamingJson(block.partialJson);
      }
      delete block.partialJson;
    }
    return;
  }
  if (event.type === "message_delta") {
    if (event.delta?.stop_reason) {
      output.stopReason = mapStopReason(event.delta.stop_reason);
    }
    applyMessageDeltaUsage(usage, event.usage, model);
  }
}

export async function consumeAnthropicStream(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  ctx: StreamConsumerContext,
): Promise<void> {
  for await (const event of events) {
    handleEvent(event as unknown as RawEvent, ctx);
  }
}

/**
 * Synthesize the streaming event sequence for a complete message so the
 * non-streaming path produces identical blocks and pi-ai events.
 */
export function messageToEvents(message: Anthropic.Message): RawEvent[] {
  const events: RawEvent[] = [
    { type: "message_start", message: { usage: message.usage as RawUsageLike } },
  ];
  const content = (message.content ?? []) as unknown as Array<
    { type: string } & Record<string, unknown>
  >;
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text as string },
      });
    } else if (block.type === "thinking") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: block.thinking as string },
      });
      if (typeof block.signature === "string" && block.signature) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        });
      }
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: block.type, id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else {
      events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: message.stop_reason ?? null },
    usage: message.usage as RawUsageLike,
  });
  events.push({ type: "message_stop" });
  return events;
}

export function consumeAnthropicMessage(
  message: Anthropic.Message,
  ctx: StreamConsumerContext,
): void {
  for (const event of messageToEvents(message)) {
    handleEvent(event, ctx);
  }
}
