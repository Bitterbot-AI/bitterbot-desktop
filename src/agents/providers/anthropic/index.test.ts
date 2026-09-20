import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai/dist/utils/event-stream.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BitterbotConfig } from "../../../config/config.js";
import type { AnthropicRequestParams, AnthropicTransport, WireTool } from "./types.js";
import { applyExtraParamsToAgent } from "../../pi-embedded-runner/extra-params.js";
import { CACHE_BOUNDARY_MARKER } from "../../system-prompt-cache-boundary.js";
import {
  createAnthropicStreamFn,
  isSystemRoleRejection,
  resetAnthropicRuntimeState,
} from "./index.js";
import {
  collect,
  makeModel,
  makeTool,
  messageEnvelope,
  sse,
  textEvents,
  toolSearchEvents,
  toolUseEvents,
} from "./test-fixtures.js";
import { markToolDeferLoading } from "./tool-search.js";

function context(): Context {
  return {
    systemPrompt: `STABLE\n${CACHE_BOUNDARY_MARKER}\n## Runtime\nnow`,
    messages: [{ role: "user", content: "weather?", timestamp: 1 }],
    tools: [
      makeTool("read"),
      markToolDeferLoading(makeTool("get_weather"), true),
      markToolDeferLoading(makeTool("browser"), true),
    ],
  };
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(
    new Error(
      `400 ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })}`,
    ),
    { status: 400 },
  );
}

beforeEach(() => {
  resetAnthropicRuntimeState();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createAnthropicStreamFn", () => {
  it("delegates non-anthropic-messages models to the fallback", async () => {
    const fallback = vi.fn<StreamFn>(() => {
      const s = new AssistantMessageEventStream();
      s.end();
      return s;
    });
    const fn = createAnthropicStreamFn(undefined, { fallback, transport: vi.fn() });
    await fn(makeModel({ api: "openai-completions" as never, provider: "openai" }), context(), {});
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("throws synchronously without an API key (vendored semantics)", () => {
    const fn = createAnthropicStreamFn(undefined, { transport: vi.fn() });
    expect(() => fn(makeModel(), context(), {})).toThrow(/No API key for provider: anthropic/);
  });

  it("round trip: deferred tools + search tool on the wire, discovered tool call surfaces as a toolCall, onPayload sees the final body", async () => {
    const seen: AnthropicRequestParams[] = [];
    const transport: AnthropicTransport = ({ params }) => {
      seen.push(structuredClone(params));
      return sse(
        messageEnvelope({
          body: [
            ...textEvents(0, ["Let me look."]),
            ...toolSearchEvents({ index: 1, id: "srv1", query: "weather", found: ["get_weather"] }),
            ...toolUseEvents(3, "toolu_1", "get_weather", ['{"path":"sf"}']),
          ],
          stopReason: "tool_use",
          startUsage: {
            cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
            cache_creation_input_tokens: 40,
          },
        }),
      );
    };
    const onPayload = vi.fn();
    const fn = createAnthropicStreamFn(undefined, { transport });
    const events = await collect(
      await fn(makeModel(), context(), { apiKey: "sk-test", onPayload }),
    );
    expect(events[0]?.type).toBe("start");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") {
      throw new Error("no done event");
    }
    expect(done.message.stopReason).toBe("toolUse");
    expect(done.message.content.map((b) => b.type)).toEqual([
      "text",
      "serverToolUse",
      "toolSearchResult",
      "toolCall",
    ]);
    expect(done.message.content[3]).toMatchObject({
      name: "get_weather",
      arguments: { path: "sf" },
    });
    expect(done.message.usage).toMatchObject({ cacheWrite: 40, cacheWrite5m: 40, cacheWrite1h: 0 });

    expect(seen).toHaveLength(1);
    const tools = seen[0]!.tools as Array<WireTool & { type?: string }>;
    expect(tools.map((t) => [t.name, t.defer_loading ?? false])).toEqual([
      ["browser", true],
      ["get_weather", true],
      ["read", false],
      ["tool_search_tool_bm25", false],
    ]);
    expect(tools.find((t) => t.name === "read")?.cache_control).toEqual({ type: "ephemeral" });
    expect(tools.some((t) => t.defer_loading && t.cache_control)).toBe(false);
    // Opus 4.8 supports mid-conversation system messages: runtime state rides there.
    expect(seen[0]!.messages.at(-1)).toMatchObject({ role: "system" });
    // onPayload observes the laid-out body (cache-trace / payload logger hook).
    expect(onPayload).toHaveBeenCalledTimes(1);
    const observed = onPayload.mock.calls[0]?.[0] as AnthropicRequestParams;
    expect(observed.tools?.length).toBe(4);
    expect(observed.messages.at(-1)).toMatchObject({ role: "system" });
  });

  it("second turn replays the search blocks and keeps the deferral flags stable", async () => {
    const seen: AnthropicRequestParams[] = [];
    const transport: AnthropicTransport = ({ params }) => {
      seen.push(structuredClone(params));
      return sse(messageEnvelope({ body: textEvents(0, ["72F"]) }));
    };
    const fn = createAnthropicStreamFn(undefined, { transport });
    const ctx = context();
    ctx.messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "serverToolUse",
            id: "srv1",
            name: "tool_search_tool_bm25",
            input: { query: "weather" },
          },
          {
            type: "toolSearchResult",
            toolUseId: "srv1",
            content: {
              type: "tool_search_tool_search_result",
              tool_references: [{ type: "tool_reference", tool_name: "get_weather" }],
            },
            toolNames: ["get_weather"],
          },
          { type: "toolCall", id: "toolu_1", name: "get_weather", arguments: { path: "sf" } },
        ] as never,
        api: "anthropic-messages",
        provider: "anthropic",
        model: makeModel().id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "get_weather",
        content: [{ type: "text", text: "72F" }],
        isError: false,
        timestamp: 3,
      },
    );
    await collect(await fn(makeModel(), ctx, { apiKey: "sk-test" }));
    const assistantWire = seen[0]!.messages[1] as { content: Array<{ type: string }> };
    expect(assistantWire.content.map((b) => b.type)).toEqual([
      "server_tool_use",
      "tool_search_tool_result",
      "tool_use",
    ]);
    const tools = seen[0]!.tools as WireTool[];
    expect(tools.find((t) => t.name === "get_weather")?.defer_loading).toBe(true);
  });

  it("falls back to user-tail on a 400 for role:system, remembers the model, still succeeds", async () => {
    const seen: AnthropicRequestParams[] = [];
    let calls = 0;
    const transport: AnthropicTransport = ({ params }) => {
      seen.push(structuredClone(params));
      calls += 1;
      if (calls === 1) {
        throw badRequest("messages.1.role: role 'system' is not supported on this model");
      }
      return sse(messageEnvelope({ body: textEvents(0, ["ok"]) }));
    };
    const fn = createAnthropicStreamFn(undefined, { transport });
    const events = await collect(await fn(makeModel(), context(), { apiKey: "sk-test" }));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.messages.at(-1)).toMatchObject({ role: "system" });
    const retryLast = seen[1]!.messages.at(-1) as {
      role: string;
      content: Array<{ text?: string }>;
    };
    expect(retryLast.role).toBe("user");
    expect(retryLast.content.at(-1)?.text?.startsWith("<runtime-state>")).toBe(true);
    // Remembered: the next request goes straight to user-tail.
    await collect(await fn(makeModel(), context(), { apiKey: "sk-test" }));
    expect(seen).toHaveLength(3);
    expect(seen[2]!.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("does not use a system message for models without support (Haiku) or with placement user-tail", async () => {
    const seen: AnthropicRequestParams[] = [];
    const transport: AnthropicTransport = ({ params }) => {
      seen.push(structuredClone(params));
      return sse(messageEnvelope({ body: textEvents(0, ["ok"]) }));
    };
    const haiku = createAnthropicStreamFn(undefined, { transport });
    await collect(await haiku(makeModel({ id: "claude-haiku-4-5" }), context(), { apiKey: "k" }));
    expect(seen[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    const forced = createAnthropicStreamFn(
      {
        agents: { defaults: { anthropic: { runtimeStatePlacement: "user-tail" } } },
      } as BitterbotConfig,
      { transport },
    );
    await collect(await forced(makeModel(), context(), { apiKey: "k" }));
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "user" });
  });

  it("other errors surface as an error event (no retry)", async () => {
    const transport = vi.fn<AnthropicTransport>(() => {
      throw Object.assign(new Error("529 overloaded"), { status: 529 });
    });
    const fn = createAnthropicStreamFn(undefined, { transport });
    const events = await collect(await fn(makeModel(), context(), { apiKey: "k" }));
    expect(transport).toHaveBeenCalledTimes(1);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.errorMessage).toContain("529");
    }
  });

  it("tool search off: no defer_loading, no search tool, dispatcher-era wire shape", async () => {
    const seen: AnthropicRequestParams[] = [];
    const transport: AnthropicTransport = ({ params }) => {
      seen.push(structuredClone(params));
      return sse(messageEnvelope({ body: textEvents(0, ["ok"]) }));
    };
    const fn = createAnthropicStreamFn(
      {
        agents: { defaults: { anthropic: { toolSearch: { enabled: false } } } },
      } as BitterbotConfig,
      { transport },
    );
    await collect(await fn(makeModel(), context(), { apiKey: "k" }));
    const tools = seen[0]!.tools as WireTool[];
    expect(tools.map((t) => t.name)).toEqual(["browser", "get_weather", "read"]);
    expect(tools.some((t) => "defer_loading" in t)).toBe(false);
  });

  it("isSystemRoleRejection matches only 400s about the system role", () => {
    expect(
      isSystemRoleRejection(badRequest("messages.1.role: role 'system' is not supported")),
    ).toBe(true);
    expect(isSystemRoleRejection(badRequest("max_tokens too large"))).toBe(false);
    expect(isSystemRoleRejection(Object.assign(new Error("role 'system'"), { status: 500 }))).toBe(
      false,
    );
  });
});

describe("runtime switch (applyExtraParamsToAgent)", () => {
  function baseSpy() {
    return vi.fn<StreamFn>(() => {
      const s = new AssistantMessageEventStream();
      s.end();
      return s;
    });
  }
  // A dead base URL: even if a key leaked in from the environment, nothing
  // leaves the machine.
  const deadModel = () => makeModel({ baseUrl: "http://127.0.0.1:9" });

  it("vendored: the chain still bottoms out in the original streamFn (byte-identical path)", async () => {
    const base = baseSpy();
    const agent = { streamFn: base as StreamFn };
    applyExtraParamsToAgent(
      agent,
      { agents: { defaults: { anthropic: { runtime: "vendored" } } } } as BitterbotConfig,
      "anthropic",
      "claude-opus-4-8",
    );
    await agent.streamFn(deadModel(), context(), {});
    expect(base).toHaveBeenCalledTimes(1);
    // The vendored path keeps the onPayload cache-layout wrapper.
    const options = base.mock.calls[0]?.[2];
    expect(typeof options?.onPayload).toBe("function");
  });

  it("native (default): anthropic-messages requests bypass the original streamFn; other apis still reach it", async () => {
    const base = baseSpy();
    const agent = { streamFn: base as StreamFn };
    applyExtraParamsToAgent(agent, {} as BitterbotConfig, "anthropic", "claude-opus-4-8");
    expect(() => agent.streamFn(deadModel(), context(), {})).toThrow(/No API key/);
    expect(base).not.toHaveBeenCalled();
    await agent.streamFn(
      makeModel({
        api: "openai-completions" as never,
        provider: "openai",
        baseUrl: "http://127.0.0.1:9",
      }),
      context(),
      {},
    );
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0]?.[0]?.api).toBe("openai-completions");
  });
});

describe("tool search activation with an absent baseUrl", () => {
  it("treats a model without baseUrl as first-party (SDK default host)", async () => {
    const { isAnthropicFirstPartyBaseUrl } = await import("./config.js");
    expect(isAnthropicFirstPartyBaseUrl(undefined)).toBe(true);
    expect(isAnthropicFirstPartyBaseUrl("")).toBe(true);
    expect(isAnthropicFirstPartyBaseUrl("https://api.anthropic.com")).toBe(true);
    expect(isAnthropicFirstPartyBaseUrl("https://proxy.example.com")).toBe(false);
  });
});

describe("deferral plan by tool-name set", () => {
  it("plans deferral from the registry when tool objects carry no flag (pi-agent-core rebuilds them)", async () => {
    const { planToolDeferral, registerDeferralPlan, resetDeferralPlansForTest } =
      await import("./tool-search.js");
    resetDeferralPlansForTest();
    const names = ["read", "exec", "wallet", "browser", "message"];
    registerDeferralPlan(names, ["wallet", "browser"]);
    const tools = names.map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
    }));
    const plan = planToolDeferral({
      tools: tools as never,
      searchEnabled: true,
      variant: "bm25",
      history: { called: new Set(), referenced: new Set() } as never,
    });
    expect([...plan.deferred].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([
      "browser",
      "wallet",
    ]);
    expect(plan.searchTool?.name).toBe("tool_search_tool_bm25");
    // A different tool set does not inherit the plan.
    const other = planToolDeferral({
      tools: tools.slice(0, 3) as never,
      searchEnabled: true,
      variant: "bm25",
      history: { called: new Set(), referenced: new Set() } as never,
    });
    expect(other.deferred.size).toBe(0);
  });
});

describe("on-demand deferred-tool rescue", () => {
  it("keeps a called-but-unreferenced tool deferred (no preemptive prefix rewrite)", async () => {
    const { planToolDeferral, registerDeferralPlan, resetDeferralPlansForTest } =
      await import("./tool-search.js");
    resetDeferralPlansForTest();
    const names = ["read", "a2a_status", "wallet"];
    registerDeferralPlan(names, ["a2a_status", "wallet"]);
    const tools = names.map((name) => ({
      name,
      description: name,
      parameters: { type: "object" },
    }));
    const plan = planToolDeferral({
      tools: tools as never,
      searchEnabled: true,
      variant: "bm25",
      history: {
        called: new Set(["a2a_status"]),
        referenced: new Set(),
        hasSearchBlocks: false,
      } as never,
    });
    expect(plan.deferred.has("a2a_status")).toBe(true);
    expect(plan.rescued).toEqual([]);
    const forced = planToolDeferral({
      tools: tools as never,
      searchEnabled: true,
      variant: "bm25",
      history: {
        called: new Set(["a2a_status"]),
        referenced: new Set(),
        hasSearchBlocks: false,
      } as never,
      forceLoaded: new Set(["a2a_status"]),
    });
    expect(forced.deferred.has("a2a_status")).toBe(false);
    expect(forced.rescued).toEqual(["a2a_status"]);
  });

  it("classifies a 400 that names a deferred tool, and ignores unrelated 400s", async () => {
    const { deferredToolsRejected } = await import("./index.js");
    const deferred = new Set(["a2a_status", "wallet"]);
    const called = new Set(["a2a_status"]);
    expect(
      deferredToolsRejected(
        badRequest("messages.3: tool_use references tool a2a_status which is deferred"),
        deferred,
        called,
      ),
    ).toEqual(["a2a_status"]);
    expect(
      deferredToolsRejected(
        badRequest("tools: unknown tool referenced in history"),
        deferred,
        called,
      ),
    ).toEqual(["a2a_status"]);
    expect(
      deferredToolsRejected(
        badRequest("messages.1.role: role 'system' is not supported on this model"),
        deferred,
        called,
      ),
    ).toEqual([]);
    expect(deferredToolsRejected(new Error("boom"), deferred, called)).toEqual([]);
  });
});
