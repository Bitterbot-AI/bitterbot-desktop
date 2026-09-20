import type { AnthropicOptions, Context, Message } from "@mariozechner/pi-ai";
import { streamAnthropic, streamSimpleAnthropic } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { AnthropicRequestParams, WireTool } from "./types.js";
import { applyAnthropicCacheLayout } from "../../pi-embedded-runner/anthropic-payload-cache.js";
import { CACHE_BOUNDARY_MARKER } from "../../system-prompt-cache-boundary.js";
import {
  buildParams,
  convertMessages,
  getCacheControl,
  resolveProviderOptions,
} from "./request.js";
import { makeModel, makeTool } from "./test-fixtures.js";
import {
  collectToolSearchHistoryState,
  markToolDeferLoading,
  planToolDeferral,
  TOOL_SEARCH_TOOL_NAMES,
  TOOL_SEARCH_TOOL_TYPES,
} from "./tool-search.js";
import { createEmptyUsage } from "./usage.js";

const NO_SEARCH = planToolDeferral({
  tools: [],
  searchEnabled: false,
  variant: "bm25",
  history: collectToolSearchHistoryState([]),
});

function assistant(
  modelId: string,
  content: Message extends { role: "assistant"; content: infer C } ? C : never,
): Message {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: modelId,
    usage: createEmptyUsage(),
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function richContext(modelId: string): Context {
  return {
    systemPrompt: "You are a test. Emoji \u{1F648} survive.",
    messages: [
      { role: "user", content: "hello", timestamp: 1 },
      assistant(modelId, [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "text", text: "hi" },
        { type: "toolCall", id: "call|weird id", name: "read", arguments: { path: "a" } },
      ]),
      {
        role: "toolResult",
        toolCallId: "call|weird id",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "and now?" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 4,
      },
    ],
    tools: [makeTool("read"), makeTool("exec")],
  };
}

/** Run the VENDORED provider up to onPayload, abort, and return the JSON it would have sent. */
async function captureVendored(
  fn: typeof streamAnthropic | typeof streamSimpleAnthropic,
  modelId: string,
  context: Context,
  options: Record<string, unknown>,
): Promise<string> {
  const controller = new AbortController();
  let captured = "";
  const stream = fn(makeModel({ id: modelId }), context, {
    ...options,
    signal: controller.signal,
    onPayload: (payload: unknown) => {
      captured = JSON.stringify(payload);
      controller.abort();
    },
  } as AnthropicOptions);
  await stream.result();
  expect(captured).not.toBe("");
  return captured;
}

describe("byte-level parity with vendored pi-ai 0.52.12", () => {
  it("streamAnthropic: identical request body (adaptive model, tools, thinking, metadata, tool_choice)", async () => {
    const modelId = "claude-opus-4-6";
    const context = richContext(modelId);
    const options = {
      apiKey: "sk-test",
      maxTokens: 1000,
      temperature: 0.2,
      cacheRetention: "long",
      thinkingEnabled: true,
      effort: "high",
      metadata: { user_id: "u1", ignored: "x" },
      toolChoice: "auto",
    };
    const vendored = await captureVendored(streamAnthropic, modelId, context, options);
    const model = makeModel({ id: modelId });
    const { cacheControl } = getCacheControl(model.baseUrl, "long");
    const native = buildParams(model, context, false, options as AnthropicOptions, {
      plan: NO_SEARCH,
      cacheControl,
    });
    expect(JSON.stringify(native)).toBe(vendored);
  });

  it("streamSimpleAnthropic: identical option derivation for budget-based thinking (Haiku 4.5)", async () => {
    const modelId = "claude-haiku-4-5";
    const context = richContext(modelId);
    const options = { apiKey: "sk-test", reasoning: "medium", maxTokens: 2000 };
    const vendored = await captureVendored(streamSimpleAnthropic, modelId, context, options);
    const model = makeModel({ id: modelId, maxTokens: 64000 });
    const providerOptions = resolveProviderOptions(model, options as never, "sk-test");
    const { cacheControl } = getCacheControl(model.baseUrl, providerOptions.cacheRetention);
    const native = buildParams(model, context, false, providerOptions, {
      plan: NO_SEARCH,
      cacheControl,
    });
    expect(JSON.stringify(native)).toBe(vendored);
    expect(native.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("streamSimpleAnthropic: identical with thinking off and default maxTokens", async () => {
    const modelId = "claude-opus-4-6";
    const context = richContext(modelId);
    const options = { apiKey: "sk-test" };
    const vendored = await captureVendored(streamSimpleAnthropic, modelId, context, options);
    const model = makeModel({ id: modelId });
    const providerOptions = resolveProviderOptions(model, options, "sk-test");
    const { cacheControl } = getCacheControl(model.baseUrl, providerOptions.cacheRetention);
    const native = buildParams(model, context, false, providerOptions, {
      plan: NO_SEARCH,
      cacheControl,
    });
    expect(JSON.stringify(native)).toBe(vendored);
  });

  it("OAuth setup-token: Claude Code identity block + tool name casing, byte-identical", async () => {
    const modelId = "claude-opus-4-6";
    const context = richContext(modelId);
    const options = { apiKey: "sk-ant-oat01-test", maxTokens: 500 };
    const vendored = await captureVendored(streamAnthropic, modelId, context, options);
    const model = makeModel({ id: modelId });
    const { cacheControl } = getCacheControl(model.baseUrl, undefined);
    const native = buildParams(model, context, true, options, { plan: NO_SEARCH, cacheControl });
    expect(JSON.stringify(native)).toBe(vendored);
    const firstTool = (native.tools ?? [])[0] as WireTool | undefined;
    expect(firstTool?.name).toBe("Read");
    expect(native.system?.[0]?.text).toContain("Claude Code");
  });

  it("documented divergence: Opus 4.8 gets adaptive thinking (vendored would send budget_tokens, a 400)", async () => {
    const modelId = "claude-opus-4-8";
    const context = richContext(modelId);
    const options = { apiKey: "sk-test", reasoning: "high" };
    const vendored = JSON.parse(
      await captureVendored(streamSimpleAnthropic, modelId, context, options),
    ) as AnthropicRequestParams;
    expect(vendored.thinking).toMatchObject({ type: "enabled" });
    const model = makeModel({ id: modelId });
    const providerOptions = resolveProviderOptions(model, options as never, "sk-test");
    const native = buildParams(model, context, false, providerOptions, {
      plan: NO_SEARCH,
      cacheControl: undefined,
    });
    expect(native.thinking).toEqual({ type: "adaptive" });
    expect(native.output_config).toEqual({ effort: "high" });
  });
});

describe("tool deferral + cache marker placement", () => {
  function deferredRegistry() {
    const read = makeTool("read");
    const exec = makeTool("exec");
    const memory = markToolDeferLoading(makeTool("memory_search"), true);
    const browser = markToolDeferLoading(makeTool("browser"), true);
    const wallet = markToolDeferLoading(makeTool("wallet"), true);
    return [wallet, read, memory, exec, browser];
  }

  it("sends every tool, defers the flagged ones, appends the search tool, marker on the last non-deferred custom tool", () => {
    const tools = deferredRegistry();
    const plan = planToolDeferral({
      tools,
      searchEnabled: true,
      variant: "bm25",
      history: collectToolSearchHistoryState([]),
    });
    expect([...plan.deferred].toSorted()).toEqual(["browser", "memory_search", "wallet"]);
    expect(plan.searchTool).toEqual({
      type: TOOL_SEARCH_TOOL_TYPES.bm25,
      name: TOOL_SEARCH_TOOL_NAMES.bm25,
    });
    const model = makeModel();
    const params = buildParams(
      model,
      {
        systemPrompt: `S\n${CACHE_BOUNDARY_MARKER}\nV`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        tools,
      },
      false,
      { apiKey: "k", maxTokens: 10 },
      { plan, cacheControl: { type: "ephemeral" } },
    );
    const layout = applyAnthropicCacheLayout(params, { type: "ephemeral" });
    const wire = params.tools as Array<WireTool & { type?: string }>;
    expect(wire.map((t) => t.name)).toEqual([
      "browser",
      "exec",
      "memory_search",
      "read",
      "tool_search_tool_bm25",
      "wallet",
    ]);
    expect(wire.filter((t) => t.defer_loading).map((t) => t.name)).toEqual([
      "browser",
      "memory_search",
      "wallet",
    ]);
    // Marker: on `read` (last non-deferred custom tool), never on a deferred tool
    // and not on the trailing deferred `wallet`.
    expect(wire.filter((t) => t.cache_control).map((t) => t.name)).toEqual(["read"]);
    expect(layout?.deferredToolCount).toBe(3);
    expect(layout?.markerCount).toBe(3); // tools + stable system + last user
    expect(wire.find((t) => t.name === "tool_search_tool_bm25")?.type).toBe(
      TOOL_SEARCH_TOOL_TYPES.bm25,
    );
  });

  it("regex variant", () => {
    const plan = planToolDeferral({
      tools: deferredRegistry(),
      searchEnabled: true,
      variant: "regex",
      history: collectToolSearchHistoryState([]),
    });
    expect(plan.searchTool?.type).toBe("tool_search_tool_regex_20251119");
    expect(plan.searchTool?.name).toBe("tool_search_tool_regex");
  });

  it("guard: never defer everything (all flagged -> nothing deferred, no search tool)", () => {
    const tools = deferredRegistry().map((t) => markToolDeferLoading(t, true));
    const plan = planToolDeferral({
      tools,
      searchEnabled: true,
      variant: "bm25",
      history: collectToolSearchHistoryState([]),
    });
    expect(plan.guardTripped).toBe(true);
    expect(plan.deferred.size).toBe(0);
    expect(plan.searchTool).toBeUndefined();
  });

  it("search disabled: flags ignored, no defer_loading on the wire (vendored shape)", () => {
    const tools = deferredRegistry();
    const plan = planToolDeferral({
      tools,
      searchEnabled: false,
      variant: "bm25",
      history: collectToolSearchHistoryState([]),
    });
    const params = buildParams(
      makeModel(),
      { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
      false,
      { apiKey: "k", maxTokens: 10 },
      { plan, cacheControl: undefined },
    );
    expect(params.tools?.some((t) => "defer_loading" in t)).toBe(false);
    expect(params.tools?.length).toBe(5);
  });

  it("a tool called in history whose search result is gone STAYS deferred (rescue is on-demand only)", () => {
    const tools = deferredRegistry();
    const plan = planToolDeferral({
      tools,
      searchEnabled: true,
      variant: "bm25",
      history: { called: new Set(["browser"]), referenced: new Set(), hasSearchBlocks: false },
    });
    expect(plan.rescued).toEqual([]);
    expect(plan.deferred.has("browser")).toBe(true);
    expect(plan.deferred.has("wallet")).toBe(true);
    const forced = planToolDeferral({
      tools,
      searchEnabled: true,
      variant: "bm25",
      history: { called: new Set(["browser"]), referenced: new Set(), hasSearchBlocks: false },
      forceLoaded: new Set(["browser"]),
    });
    expect(forced.rescued).toEqual(["browser"]);
    expect(forced.deferred.has("browser")).toBe(false);
  });

  it("no rescue when the search result that discovered the tool is still in history", () => {
    const tools = deferredRegistry();
    const history = collectToolSearchHistoryState([
      assistant("claude-opus-4-8", [
        { type: "serverToolUse", id: "s", name: "tool_search_tool_bm25", input: { query: "b" } },
        { type: "toolSearchResult", toolUseId: "s", content: {}, toolNames: ["browser"] },
        { type: "toolCall", id: "t1", name: "browser", arguments: {} },
      ] as never),
    ]);
    const plan = planToolDeferral({ tools, searchEnabled: true, variant: "bm25", history });
    expect(plan.rescued).toEqual([]);
    expect(plan.deferred.has("browser")).toBe(true);
  });
});

describe("search block replay in history", () => {
  const searchTurn = assistant("claude-opus-4-8", [
    { type: "text", text: "Searching." },
    {
      type: "serverToolUse",
      id: "srv1",
      name: "tool_search_tool_bm25",
      input: { query: "browser" },
    },
    {
      type: "toolSearchResult",
      toolUseId: "srv1",
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [
          { type: "tool_reference", tool_name: "browser" },
          { type: "tool_reference", tool_name: "gone_tool" },
        ],
      },
      toolNames: ["browser", "gone_tool"],
    },
    { type: "toolCall", id: "t1", name: "browser", arguments: { path: "x" } },
  ] as never);

  it("replays server_tool_use + tool_search_tool_result verbatim, dropping references to unregistered tools", () => {
    const wire = convertMessages([searchTurn], makeModel(), false, undefined, {
      searchToolPresent: true,
      knownToolNames: new Set(["browser", "read"]),
    });
    expect(wire).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          {
            type: "server_tool_use",
            id: "srv1",
            name: "tool_search_tool_bm25",
            input: { query: "browser" },
          },
          {
            type: "tool_search_tool_result",
            tool_use_id: "srv1",
            content: {
              type: "tool_search_tool_search_result",
              tool_references: [{ type: "tool_reference", tool_name: "browser" }],
            },
          },
          { type: "tool_use", id: "t1", name: "browser", input: { path: "x" } },
        ],
      },
    ]);
  });

  it("without the search tool in the request the search blocks are not replayed", () => {
    const wire = convertMessages([searchTurn], makeModel(), false, undefined, {
      searchToolPresent: false,
      knownToolNames: new Set(["browser"]),
    });
    const content = (wire[0] as { content: Array<{ type: string }> }).content;
    expect(content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });
});

describe("runtime-state placement", () => {
  function payload(): AnthropicRequestParams {
    return buildParams(
      makeModel(),
      {
        systemPrompt: `STABLE\n${CACHE_BOUNDARY_MARKER}\n## Runtime\nhormones: 0.3`,
        messages: [
          { role: "user", content: "hi", timestamp: 1 },
          assistant("claude-opus-4-8", [
            { type: "toolCall", id: "t1", name: "read", arguments: {} },
          ]),
          {
            role: "toolResult",
            toolCallId: "t1",
            toolName: "read",
            content: [{ type: "text", text: "r" }],
            isError: false,
            timestamp: 3,
          },
        ],
        tools: [makeTool("read")],
      },
      false,
      { apiKey: "k", maxTokens: 10 },
      { plan: NO_SEARCH, cacheControl: { type: "ephemeral" } },
    );
  }

  it("system-message: a role:system message follows the (marked) tool_result user message", () => {
    const params = payload();
    const result = applyAnthropicCacheLayout(
      params,
      { type: "ephemeral" },
      { volatilePlacement: "system-message" },
    );
    expect(result?.volatilePlacement).toBe("system-message");
    const last = params.messages.at(-1) as {
      role: string;
      content: Array<{ type: string; text: string; cache_control?: unknown }>;
    };
    expect(last.role).toBe("system");
    expect(last.content[0]?.text).toBe(
      "<runtime-state>\n## Runtime\nhormones: 0.3\n</runtime-state>",
    );
    expect(last.content[0]?.cache_control).toBeUndefined();
    const user = params.messages.at(-2) as {
      role: string;
      content: Array<{ type: string; cache_control?: unknown }>;
    };
    expect(user.role).toBe("user");
    expect(user.content).toHaveLength(1);
    expect(user.content[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(params.system?.[0]?.text).toBe("STABLE");
    expect(result?.markerCount).toBe(3);
    // Idempotent.
    applyAnthropicCacheLayout(
      params,
      { type: "ephemeral" },
      { volatilePlacement: "system-message" },
    );
    expect(params.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("user-tail (default): unchanged behavior, no system message", () => {
    const params = payload();
    const result = applyAnthropicCacheLayout(params, { type: "ephemeral" });
    expect(result?.volatilePlacement).toBe("user-tail");
    expect(params.messages.some((m) => m.role === "system")).toBe(false);
    const user = params.messages.at(-1) as { content: Array<{ type: string; text?: string }> };
    expect(user.content).toHaveLength(2);
    expect(user.content[1]?.text?.startsWith("<runtime-state>")).toBe(true);
  });
});
