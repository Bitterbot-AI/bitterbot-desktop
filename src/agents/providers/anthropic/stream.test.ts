import type Anthropic from "@anthropic-ai/sdk";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { describe, expect, it } from "vitest";
import type { AnthropicUsage } from "./types.js";
import { consumeAnthropicMessage, consumeAnthropicStream, mapStopReason } from "./stream.js";
import {
  makeModel,
  makeTool,
  messageEnvelope,
  sse,
  textEvents,
  thinkingEvents,
  toolSearchEvents,
  toolUseEvents,
  type SyntheticEvent,
} from "./test-fixtures.js";
import { createEmptyUsage } from "./usage.js";

function freshOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: makeModel().id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

async function run(events: SyntheticEvent[], opts: { isOAuthToken?: boolean } = {}) {
  const output = freshOutput();
  const stream = new AssistantMessageEventStream();
  const pushed: string[] = [];
  const originalPush = stream.push.bind(stream);
  stream.push = (event) => {
    pushed.push(`${event.type}@${"contentIndex" in event ? event.contentIndex : "-"}`);
    originalPush(event);
  };
  await consumeAnthropicStream(sse(events), {
    output,
    stream,
    model: makeModel(),
    isOAuthToken: opts.isOAuthToken ?? false,
    tools: [makeTool("read"), makeTool("get_weather")],
  });
  return { output, pushed };
}

describe("consumeAnthropicStream", () => {
  it("plain text: one text block, start/delta/end events, usage and stop reason", async () => {
    const { output, pushed } = await run(messageEnvelope({ body: textEvents(0, ["Hel", "lo"]) }));
    expect(output.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(pushed).toEqual(["text_start@0", "text_delta@0", "text_delta@0", "text_end@0"]);
    expect(output.stopReason).toBe("stop");
    expect(output.usage.input).toBe(12);
    expect(output.usage.output).toBe(9);
    expect(output.usage.totalTokens).toBe(21);
    expect(output.usage.cost.total).toBeGreaterThan(0);
  });

  it("tool_use: fine-grained JSON deltas accumulate into arguments; stop reason toolUse", async () => {
    const { output, pushed } = await run(
      messageEnvelope({
        body: toolUseEvents(0, "toolu_1", "read", ['{"pa', 'th":"a.txt"}']),
        stopReason: "tool_use",
      }),
    );
    expect(output.content).toEqual([
      { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
    ]);
    expect(pushed).toEqual([
      "toolcall_start@0",
      "toolcall_delta@0",
      "toolcall_delta@0",
      "toolcall_end@0",
    ]);
    expect(output.stopReason).toBe("toolUse");
    expect("partialJson" in (output.content[0] as object)).toBe(false);
  });

  it("parallel tool_use: interleaved deltas land on the right block by stream index", async () => {
    const body: SyntheticEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "a", name: "read", input: {} },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "b", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"b"}' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
    ];
    const { output } = await run(messageEnvelope({ body, stopReason: "tool_use" }));
    expect(output.content).toEqual([
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "get_weather", arguments: { path: "b" } },
    ]);
  });

  it("thinking + signature, interleaved with text and a tool call", async () => {
    const { output, pushed } = await run(
      messageEnvelope({
        body: [
          ...thinkingEvents(0, ["let me ", "think"], "sig123"),
          ...textEvents(1, ["ok"]),
          ...toolUseEvents(2, "t", "read", ["{}"]),
        ],
        stopReason: "tool_use",
      }),
    );
    expect(output.content).toEqual([
      { type: "thinking", thinking: "let me think", thinkingSignature: "sig123" },
      { type: "text", text: "ok" },
      { type: "toolCall", id: "t", name: "read", arguments: {} },
    ]);
    expect(pushed.slice(0, 3)).toEqual([
      "thinking_start@0",
      "thinking_delta@0",
      "thinking_delta@0",
    ]);
    expect(pushed).toContain("thinking_end@0");
  });

  it("tool search: server_tool_use + tool_search_tool_result are stored, the discovered tool_use is a normal toolCall", async () => {
    const { output, pushed } = await run(
      messageEnvelope({
        body: [
          ...textEvents(0, ["Searching."]),
          ...toolSearchEvents({
            index: 1,
            id: "srvtoolu_1",
            query: "weather",
            found: ["get_weather"],
          }),
          ...toolUseEvents(3, "toolu_9", "get_weather", ['{"path":"sf"}']),
        ],
        stopReason: "tool_use",
      }),
    );
    expect(output.content).toEqual([
      { type: "text", text: "Searching." },
      {
        type: "serverToolUse",
        id: "srvtoolu_1",
        name: "tool_search_tool_bm25",
        input: { query: "weather" },
      },
      {
        type: "toolSearchResult",
        toolUseId: "srvtoolu_1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
        },
        toolNames: ["get_weather"],
      },
      { type: "toolCall", id: "toolu_9", name: "get_weather", arguments: { path: "sf" } },
    ]);
    // No pi-ai events for the server blocks; the tool call sits at content index 3.
    expect(pushed.filter((p) => p.startsWith("toolcall"))).toEqual([
      "toolcall_start@3",
      "toolcall_delta@3",
      "toolcall_end@3",
    ]);
    expect(output.stopReason).toBe("toolUse");
  });

  it("tool search error result: stored verbatim with no tool names", async () => {
    const { output } = await run(
      messageEnvelope({
        body: [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_search_tool_result",
              tool_use_id: "srv",
              content: {
                type: "tool_search_tool_result_error",
                error_code: "unavailable",
                error_message: "x",
              },
            },
          },
          { type: "content_block_stop", index: 0 },
        ],
      }),
    );
    expect(output.content[0]).toMatchObject({ type: "toolSearchResult", toolNames: [] });
  });

  it("usage: cache_creation TTL split surfaces as cacheWrite5m / cacheWrite1h", async () => {
    const { output } = await run(
      messageEnvelope({
        body: textEvents(0, ["x"]),
        startUsage: {
          input_tokens: 10,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
        },
        deltaUsage: { output_tokens: 7 },
      }),
    );
    const usage = output.usage as AnthropicUsage;
    expect(usage).toMatchObject({
      input: 10,
      output: 7,
      cacheRead: 5000,
      cacheWrite: 100,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
      totalTokens: 5117,
    });
  });

  it("usage: without cache_creation the split stays undefined (proxies)", async () => {
    const { output } = await run(messageEnvelope({ body: textEvents(0, ["x"]) }));
    const usage = output.usage as AnthropicUsage;
    expect(usage.cacheWrite5m).toBeUndefined();
    expect(usage.cacheWrite1h).toBeUndefined();
  });

  it("OAuth: Claude Code tool names map back to the registered casing", async () => {
    const { output } = await run(
      messageEnvelope({ body: toolUseEvents(0, "t", "Read", ["{}"]), stopReason: "tool_use" }),
      { isOAuthToken: true },
    );
    expect(output.content[0]).toMatchObject({ type: "toolCall", name: "read" });
  });

  it("non-streaming message produces the same blocks as the stream", async () => {
    const message = {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [
        { type: "text", text: "Searching." },
        {
          type: "server_tool_use",
          id: "srvtoolu_1",
          name: "tool_search_tool_bm25",
          input: { query: "weather" },
        },
        {
          type: "tool_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: {
            type: "tool_search_tool_search_result",
            tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
          },
        },
        { type: "thinking", thinking: "t", signature: "s" },
        { type: "tool_use", id: "toolu_9", name: "get_weather", input: { path: "sf" } },
      ],
    } as unknown as Anthropic.Message;
    const output = freshOutput();
    consumeAnthropicMessage(message, {
      output,
      stream: new AssistantMessageEventStream(),
      model: makeModel(),
      isOAuthToken: false,
    });
    expect(output.content).toEqual([
      { type: "text", text: "Searching." },
      {
        type: "serverToolUse",
        id: "srvtoolu_1",
        name: "tool_search_tool_bm25",
        input: { query: "weather" },
      },
      {
        type: "toolSearchResult",
        toolUseId: "srvtoolu_1",
        content: {
          type: "tool_search_tool_search_result",
          tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
        },
        toolNames: ["get_weather"],
      },
      { type: "thinking", thinking: "t", thinkingSignature: "s" },
      { type: "toolCall", id: "toolu_9", name: "get_weather", arguments: { path: "sf" } },
    ]);
    expect(output.stopReason).toBe("toolUse");
    expect(output.usage.totalTokens).toBe(7);
  });
});

describe("mapStopReason", () => {
  it("matches the vendored table", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("toolUse");
    expect(mapStopReason("refusal")).toBe("error");
    expect(mapStopReason("pause_turn")).toBe("stop");
    expect(mapStopReason("sensitive")).toBe("error");
    expect(() => mapStopReason("brand_new")).toThrow(/Unhandled stop reason/);
  });
});
