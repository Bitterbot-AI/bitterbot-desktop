import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { PreActionInterceptor } from "./interceptor.js";
import {
  setInterceptorContextProviders,
  clearInterceptorContextProviders,
} from "./interceptor-context.js";
import { getInterceptorRegistry } from "./interceptor-registry.js";
import { runInterceptors, resetInterceptorRunnerState } from "./interceptor-runner.js";

function makeInterceptor(
  opts: Partial<PreActionInterceptor> & Pick<PreActionInterceptor, "id" | "skill">,
): PreActionInterceptor {
  return {
    priority: 0,
    shouldActivate: () => true,
    intervene: () => ({ type: "noop" }),
    ...opts,
  };
}

describe("interceptor-runner", () => {
  beforeEach(() => {
    getInterceptorRegistry().clear();
    resetInterceptorRunnerState();
    clearInterceptorContextProviders();
  });
  afterEach(() => {
    getInterceptorRegistry().clear();
    clearInterceptorContextProviders();
  });

  it("passes through when no interceptor matches the tool name", async () => {
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:y",
        skill: "x",
        tools: ["other_tool"],
        intervene: () => ({ type: "modify", newParams: { changed: true }, reason: "x" }),
      }),
      "builtin",
    );
    const out = await runInterceptors({ toolName: "memory_search", params: { q: "abc" } });
    expect(out.kind).toBe("pass");
  });

  it("modifies params when an interceptor returns a modify intervention", async () => {
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:y",
        skill: "x",
        tools: ["memory_search"],
        intervene: () => ({ type: "modify", newParams: { q: "REWRITTEN" }, reason: "x" }),
      }),
      "builtin",
    );
    const out = await runInterceptors({ toolName: "memory_search", params: { q: "orig" } });
    expect(out.kind).toBe("modify");
    if (out.kind === "modify") {
      expect(out.params.q).toBe("REWRITTEN");
    }
  });

  it("blocks when intervention type is block", async () => {
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:y",
        skill: "x",
        tools: ["wallet_send"],
        intervene: () => ({ type: "block", reason: "cortisol too high" }),
      }),
      "builtin",
    );
    const out = await runInterceptors({ toolName: "wallet_send", params: {} });
    expect(out.kind).toBe("block");
  });

  it("respects priority ordering — higher priority fires first", async () => {
    const calls: string[] = [];
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "a:lo",
        skill: "a",
        priority: 1,
        tools: ["t"],
        shouldActivate: () => {
          calls.push("a");
          return false;
        },
      }),
      "builtin",
    );
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "b:hi",
        skill: "b",
        priority: 9,
        tools: ["t"],
        shouldActivate: () => {
          calls.push("b");
          return false;
        },
      }),
      "builtin",
    );
    await runInterceptors({ toolName: "t", params: {} });
    expect(calls).toEqual(["b", "a"]);
  });

  it("enforces maxFiresPerEpisode", async () => {
    let fires = 0;
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:capped",
        skill: "x",
        maxFiresPerEpisode: 2,
        tools: ["t"],
        shouldActivate: () => true,
        intervene: () => {
          fires += 1;
          return { type: "modify", newParams: {}, reason: "fire" };
        },
      }),
      "builtin",
    );
    await runInterceptors({ toolName: "t", params: {}, sessionKey: "s" });
    await runInterceptors({ toolName: "t", params: {}, sessionKey: "s" });
    await runInterceptors({ toolName: "t", params: {}, sessionKey: "s" });
    expect(fires).toBe(2);
  });

  it("auto-disables an interceptor after 3 throws in a session", async () => {
    let evaluated = 0;
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:bad",
        skill: "x",
        tools: ["t"],
        shouldActivate: () => {
          evaluated += 1;
          throw new Error("boom");
        },
      }),
      "builtin",
    );
    for (let i = 0; i < 5; i++) {
      await runInterceptors({ toolName: "t", params: {}, sessionKey: "s" });
    }
    // 3 strikes → disabled before further evaluations
    expect(evaluated).toBeLessThanOrEqual(3);
    expect(getInterceptorRegistry().isDisabled("x:bad")).toBe(true);
  });

  it("returns require_prereq when an interceptor requests a prereq tool", async () => {
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:prereq",
        skill: "x",
        tools: ["send_message"],
        intervene: () => ({
          type: "require_prereq",
          tool: "memory_search",
          params: { query: "Q" },
          reason: "ground first",
        }),
      }),
      "builtin",
    );
    const out = await runInterceptors({
      toolName: "send_message",
      params: { text: "X is Y" },
    });
    expect(out.kind).toBe("require_prereq");
    if (out.kind === "require_prereq") {
      expect(out.tool).toBe("memory_search");
      expect(out.params.query).toBe("Q");
    }
  });

  it("autoExtractDraft picks up text/content/body/message from message-shaped tool params", async () => {
    let seenDraft: string | undefined;
    getInterceptorRegistry().register(
      makeInterceptor({
        id: "x:probe",
        skill: "x",
        tools: ["send_message", "discord_send"],
        shouldActivate: (ctx) => {
          seenDraft = ctx.draftReply;
          return false;
        },
      }),
      "builtin",
    );
    await runInterceptors({ toolName: "send_message", params: { text: "hello" } });
    expect(seenDraft).toBe("hello");
    seenDraft = undefined;
    await runInterceptors({ toolName: "discord_send", params: { content: "world" } });
    expect(seenDraft).toBe("world");
  });
});
