/**
 * Test-only fixtures for the in-tree Anthropic provider (synthetic SSE
 * streams, models, tools). Not imported by production code.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessageEvent, Model, Tool } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { Type } from "@sinclair/typebox";

export const TEST_MODEL_ID = "claude-opus-4-8";

export function makeModel(
  overrides: Partial<Model<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
  return {
    id: TEST_MODEL_ID,
    name: "Claude Opus 4.8",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  };
}

export function makeTool(name: string, description = `${name} tool`): Tool {
  return {
    name,
    description,
    parameters: Type.Object({ path: Type.Optional(Type.String({ description: "a path" })) }),
  };
}

/** Loose event objects; the SDK union predates tool search block types. */
export type SyntheticEvent = Record<string, unknown> & { type: string };

export function sse(events: SyntheticEvent[]): AsyncIterable<Anthropic.RawMessageStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event as unknown as Anthropic.RawMessageStreamEvent;
      }
    },
  };
}

export async function collect(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export const usageStart = (extra: Record<string, unknown> = {}) => ({
  input_tokens: 12,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...extra,
});

export function textEvents(index: number, chunks: string[]): SyntheticEvent[] {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...chunks.map((text) => ({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index },
  ];
}

export function toolUseEvents(
  index: number,
  id: string,
  name: string,
  jsonChunks: string[],
): SyntheticEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    ...jsonChunks.map((partial_json) => ({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index },
  ];
}

export function thinkingEvents(
  index: number,
  chunks: string[],
  signature: string,
): SyntheticEvent[] {
  return [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } },
    ...chunks.map((thinking) => ({
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking },
    })),
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index },
  ];
}

export function toolSearchEvents(params: {
  index: number;
  id: string;
  name?: string;
  query: string;
  found: string[];
}): SyntheticEvent[] {
  const name = params.name ?? "tool_search_tool_bm25";
  return [
    {
      type: "content_block_start",
      index: params.index,
      content_block: { type: "server_tool_use", id: params.id, name },
    },
    {
      type: "content_block_delta",
      index: params.index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: params.query }) },
    },
    { type: "content_block_stop", index: params.index },
    {
      type: "content_block_start",
      index: params.index + 1,
      content_block: {
        type: "tool_search_tool_result",
        tool_use_id: params.id,
        content: {
          type: "tool_search_tool_search_result",
          tool_references: params.found.map((tool_name) => ({ type: "tool_reference", tool_name })),
        },
      },
    },
    { type: "content_block_stop", index: params.index + 1 },
  ];
}

export function messageEnvelope(params: {
  body: SyntheticEvent[];
  stopReason?: string;
  startUsage?: Record<string, unknown>;
  deltaUsage?: Record<string, unknown>;
}): SyntheticEvent[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [],
        usage: usageStart(params.startUsage),
      },
    },
    ...params.body,
    {
      type: "message_delta",
      delta: { stop_reason: params.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: 9, ...params.deltaUsage },
    },
    { type: "message_stop" },
  ];
}
