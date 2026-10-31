import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemorySearchManager } from "../../memory/types.js";
import type { RLMLiveApis } from "../rlm/types.js";
import { createDeepRecallTool, clearDeepRecallSandboxCache } from "./deep-recall-tool.js";

const { search } = vi.hoisted(() => ({ search: vi.fn<MemorySearchManager["search"]>() }));
vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: async () => ({ manager: { search } }),
}));
vi.mock("./deep-recall-budget.js", () => ({ checkRecallBudget: () => ({ exhausted: false }) }));
vi.mock("../agent-paths.js", () => ({
  resolveBitterbotAgentDir: () => {
    throw Error("no durable test store");
  },
}));
vi.mock("../rlm/executor.js", () => ({
  RLMExecutor: class {
    getCachedResult() {
      return null;
    }
    async execute(_query: string, _context: string, opts: { liveApis: RLMLiveApis }) {
      await opts.liveApis.search!("live API question");
      return { answer: "fixture answer", success: true, iterations: 1, subCalls: 0, cost: 0 };
    }
  },
}));

function tool(senderIsOwner: boolean, sessionKey: string) {
  return createDeepRecallTool({
    config: {
      agents: { defaults: { memorySearch: { enabled: true, provider: "openai" } } },
      memory: { rlm: { enabled: true, subModel: "test/model" } },
    },
    agentSessionKey: sessionKey,
    senderIsOwner,
  })!;
}
beforeEach(() => {
  search.mockReset();
});
afterEach(() => {
  clearDeepRecallSandboxCache();
});

it.each([false, true])("propagates owner=%s through the shortcut", async (owner) => {
  search.mockResolvedValue(
    [1, 2, 3].map((i) => ({
      path: `memory/${i}`,
      source: "memory",
      startLine: 1,
      endLine: 1,
      snippet: "fixture",
      score: 0.95,
    })),
  );
  const result = await tool(owner, "agent:review:shortcut").execute("call", {
    query: "shortcut",
    scope: "current_session",
  });
  expect(JSON.stringify(result)).toContain("memory_search_shortcut");
  expect(search).toHaveBeenCalledExactlyOnceWith(
    "shortcut",
    expect.objectContaining({
      observe: owner,
      sessionKey: "agent:review:shortcut",
      caller: "deep_recall",
    }),
  );
});

it.each([false, true])(
  "propagates owner=%s through fallback, context and live API searches",
  async (owner) => {
    search.mockResolvedValue([
      {
        path: "memory/fixture",
        source: "memory",
        startLine: 1,
        endLine: 1,
        snippet:
          "A sufficiently long fixture for testing deep recall context construction without provider calls.",
        score: 0.1,
      },
    ]);
    const sessionKey = "agent:review:long";
    const result = await tool(owner, sessionKey).execute("call", {
      query: "needs reasoning",
      scope: "current_session",
    });
    expect(JSON.stringify(result)).toContain("fixture answer");
    expect(search.mock.calls.some(([q]) => q === "live API question")).toBe(true);
    expect(search.mock.calls.filter(([, opts]) => opts?.caller === "rlm_context")).toHaveLength(3);
    expect(search.mock.calls.filter(([q]) => q === "needs reasoning")).toHaveLength(2);
    for (const [, opts] of search.mock.calls)
      expect(opts).toMatchObject({ observe: owner, sessionKey });
  },
);

it("does not reuse an owner's sandbox context for a guest in the same session", async () => {
  search.mockResolvedValue([
    {
      path: "memory/fixture",
      source: "memory",
      startLine: 1,
      endLine: 1,
      snippet:
        "A sufficiently long fixture for testing deep recall context construction without provider calls.",
      score: 0.1,
    },
  ]);
  const sessionKey = "agent:review:shared";
  await tool(true, sessionKey).execute("owner-call", {
    query: "owner question",
    scope: "current_session",
  });
  search.mockClear();
  await tool(false, sessionKey).execute("guest-call", {
    query: "guest question",
    scope: "current_session",
  });
  expect(search.mock.calls.filter(([, opts]) => opts?.caller === "rlm_context")).toHaveLength(3);
  for (const [, opts] of search.mock.calls)
    expect(opts).toMatchObject({ observe: false, sessionKey });
});
