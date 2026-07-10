/**
 * PLAN-34 Phase 1 — the directive injection call site in
 * resolveEndocrineState (adversarial-pass finding: the B1-fix premise
 * lived in an untested ternary behind an unchecked cast). Contract:
 * - live first-party turn: questions render AND the session key is passed
 *   for once-per-conversation ask counting;
 * - compaction/status (no userMessage): render, never count;
 * - non-first-party keys (subagents, cron): neither render nor count.
 */
import { describe, expect, it, vi } from "vitest";

type Call = { opts?: { sessionKey?: string } };

const calls: Call[] = [];
let engineStub: unknown = null;

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: async () =>
      engineStub === null
        ? null
        : {
            hormonalState: () => null,
            hormonalManager: null,
            gccrfDiagnostics: undefined,
            epistemicDirectiveEngine: engineStub,
            prospectiveMemoryEngine: null,
            coherenceTracker: null,
            recallForUserTurn: async () => ({ facts: undefined, embedding: null }),
          },
  },
}));

function installEngine(): void {
  calls.length = 0;
  engineStub = {
    getDirectivesForSession(opts?: { sessionKey?: string }) {
      calls.push({ opts });
      return [{ question: "Which repo is current?" }];
    },
  };
}

async function resolve(params: { userMessage?: string; sessionKey?: string }) {
  const { resolveEndocrineState } = await import("./endocrine-state.js");
  return resolveEndocrineState({
    agentId: "test",
    workspaceDir: "/nonexistent",
    ...params,
  });
}

describe("resolveEndocrineState — directive injection call site", () => {
  it("live first-party turn: renders the question and passes the session key for counting", async () => {
    installEngine();
    const state = await resolve({ userMessage: "hi", sessionKey: "agent:test:cli" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ sessionKey: "agent:test:cli" });
    expect(state?.proactiveMemories).toContain("[question] Which repo is current?");
  });

  it("compaction/status (no userMessage, no key): renders without counting", async () => {
    installEngine();
    const state = await resolve({});
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toBeUndefined();
    expect(state?.proactiveMemories).toContain("[question]");
  });

  it("live turn without a session key: renders without counting", async () => {
    installEngine();
    await resolve({ userMessage: "hi" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toBeUndefined();
  });

  it("subagent session: neither renders nor counts", async () => {
    installEngine();
    const state = await resolve({
      userMessage: "task payload",
      sessionKey: "agent:test:subagent:x1",
    });
    expect(calls).toHaveLength(0);
    expect(state?.proactiveMemories ?? "").not.toContain("[question]");
  });

  it("cron session (unknown trust): neither renders nor counts", async () => {
    installEngine();
    const state = await resolve({ userMessage: "cron payload", sessionKey: "cron:job-42" });
    expect(calls).toHaveLength(0);
    expect(state?.proactiveMemories ?? "").not.toContain("[question]");
  });
});
