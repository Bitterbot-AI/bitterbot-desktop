import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PLAN-29 Phase 0.3 wiring test: ensureSkillSnapshot must resolve the
// load-time capability gate (on by default) and hand it to
// buildWorkspaceSkillSnapshot, and must skip the gate entirely when
// skills.p2p.loadTimeCapabilityGate === false. The gate machinery itself is
// covered by the capability-gate tests; this pins the wiring that was dead
// from PLAN-13 until now.

const buildCalls: Array<Record<string, unknown>> = [];
const runtimeFactoryCalls: Array<Record<string, unknown>> = [];
const SENTINEL_GATE = { getTrustTier: () => "untrusted", getGrants: () => [] };

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: (_dir: string, opts: Record<string, unknown>) => {
    buildCalls.push(opts);
    return { prompt: "", skills: [], version: opts.snapshotVersion ?? 0 };
  },
}));

vi.mock("../../agents/skills/capability-runtime.js", () => ({
  createCapabilityRuntimeFromMemory: async (opts: Record<string, unknown>) => {
    runtimeFactoryCalls.push(opts);
    return { gateContext: SENTINEL_GATE, buildEnforcerContext: () => ({}) };
  },
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: () => {},
  getSkillsSnapshotVersion: () => 0,
}));

import { ensureSkillSnapshot } from "./session-updates.js";

let savedFast: string | undefined;

beforeEach(() => {
  buildCalls.length = 0;
  runtimeFactoryCalls.length = 0;
  savedFast = process.env.BITTERBOT_TEST_FAST;
  delete process.env.BITTERBOT_TEST_FAST;
});

afterEach(() => {
  if (savedFast === undefined) delete process.env.BITTERBOT_TEST_FAST;
  else process.env.BITTERBOT_TEST_FAST = savedFast;
});

describe("ensureSkillSnapshot load-time capability gate", () => {
  it("resolves the gate by default and passes it to the snapshot build", async () => {
    await ensureSkillSnapshot({
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/ws-gate-test",
      cfg: {} as never,
      agentId: "agent-7",
    });
    expect(runtimeFactoryCalls).toHaveLength(1);
    expect(runtimeFactoryCalls[0].agentId).toBe("agent-7");
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0].capabilityGate).toBe(SENTINEL_GATE);
  });

  it("defaults the agent id when none is provided", async () => {
    await ensureSkillSnapshot({
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/ws-gate-test",
      cfg: {} as never,
    });
    expect(runtimeFactoryCalls).toHaveLength(1);
    expect(runtimeFactoryCalls[0].agentId).toBe("default");
  });

  it("skips the gate when skills.p2p.loadTimeCapabilityGate is false", async () => {
    await ensureSkillSnapshot({
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/ws-gate-test",
      cfg: { skills: { p2p: { loadTimeCapabilityGate: false } } } as never,
      agentId: "agent-7",
    });
    expect(runtimeFactoryCalls).toHaveLength(0);
    expect(buildCalls).toHaveLength(1);
    expect(buildCalls[0].capabilityGate).toBeUndefined();
  });

  it("does not resolve the gate when a cached snapshot makes a build unnecessary", async () => {
    const cached = { prompt: "", skills: [], version: 0 } as never;
    await ensureSkillSnapshot({
      sessionEntry: { sessionId: "s", updatedAt: 0, skillsSnapshot: cached } as never,
      isFirstTurnInSession: false,
      workspaceDir: "/tmp/ws-gate-test",
      cfg: {} as never,
      agentId: "agent-7",
    });
    expect(runtimeFactoryCalls).toHaveLength(0);
    expect(buildCalls).toHaveLength(0);
  });
});
