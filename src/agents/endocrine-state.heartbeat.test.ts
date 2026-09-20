/**
 * Token-efficiency pass (2026-09-19): resolveEndocrineState must make zero
 * paid calls on a heartbeat build, and at most ONE embed on a live turn
 * (the brief, cached by hash; the user-message embedding comes from
 * proactive recall). The old code embedded the brief against its own
 * nextSteps twice per prompt build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spy = {
  embedQuery: [] as string[],
  recall: [] as string[],
  recallEmbedding: [1, 0] as number[],
  briefVector: [1, 0] as number[],
};

vi.mock("../memory/manager.js", () => ({
  MemoryIndexManager: {
    get: async () => ({
      hormonalState: () => ({ dopamine: 0.4, cortisol: 0.2, oxytocin: 0.3 }),
      hormonalManager: {
        responseModulation: () => ({ briefing: "steady" }),
        getRetrievalModulation: () => ({ importanceBoost: 0, recencyBias: 0 }),
      },
      gccrfDiagnostics: undefined,
      provider: {
        embedQuery: async (text: string) => {
          spy.embedQuery.push(text);
          return spy.briefVector;
        },
      },
      recallForUserTurn: async (text: string) => {
        spy.recall.push(text);
        return { facts: undefined, embedding: spy.recallEmbedding };
      },
      epistemicDirectiveEngine: null,
      prospectiveMemoryEngine: null,
      coherenceTracker: null,
      db: null,
      userModelManager: null,
      proactiveRecallCooldown: new Map(),
    }),
  },
}));

describe("resolveEndocrineState — paid-call budget", () => {
  let ws: string;
  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "bb-endo-"));
    const { formatHandoverBrief } = await import("../memory/session-handover.js");
    fs.mkdirSync(path.join(ws, "memory", "handover"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, "memory", "handover", "2026-09-18-10.md"),
      formatHandoverBrief({
        sessionId: "s",
        purpose: "Fix the deploy pipeline",
        milestones: ["found the bug"],
        decisions: [],
        blockers: [],
        nextSteps: ["ship it"],
        entities: [],
        timestamp: Date.now(),
      }),
    );
    spy.embedQuery.length = 0;
    spy.recall.length = 0;
    spy.recallEmbedding = [1, 0];
    spy.briefVector = [1, 0];
    const { resetContinuityGateCache } = await import("../memory/continuity-gate.js");
    resetContinuityGateCache();
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  async function resolve(params: { userMessage?: string; isHeartbeat?: boolean }) {
    const { resolveEndocrineState } = await import("./endocrine-state.js");
    return resolveEndocrineState({
      agentId: "t",
      workspaceDir: ws,
      sessionKey: "agent:t",
      ...params,
    });
  }

  it("heartbeat: no recall, no embeds, brief still rendered (fail-open)", async () => {
    const state = await resolve({ userMessage: "Read HEARTBEAT.md ...", isHeartbeat: true });
    expect(spy.recall).toEqual([]);
    expect(spy.embedQuery).toEqual([]);
    expect(state?.lastSessionBrief).toContain("Fix the deploy pipeline");
    expect(state?.hormonesAvailable).toBe(true);
  });

  it("live turn: one embed for the brief (message embedding reused), then zero on the next turn", async () => {
    const first = await resolve({ userMessage: "is the deploy green?" });
    expect(spy.recall).toEqual(["is the deploy green?"]);
    expect(spy.embedQuery).toEqual(["Fix the deploy pipeline"]);
    expect(first?.lastSessionBrief).toContain("Fix the deploy pipeline");

    const second = await resolve({ userMessage: "and the tests?" });
    expect(spy.embedQuery.length).toBe(1); // brief served from cache
    expect(second?.lastSessionBrief).toContain("Fix the deploy pipeline");
  });

  it("live turn on an unrelated topic drops the brief", async () => {
    spy.recallEmbedding = [0, 1];
    const state = await resolve({ userMessage: "write a birthday poem" });
    expect(state?.lastSessionBrief).toBeUndefined();
  });

  it("no user message (status/compaction): no paid calls, brief rendered", async () => {
    const state = await resolve({});
    expect(spy.recall).toEqual([]);
    expect(spy.embedQuery).toEqual([]);
    expect(state?.lastSessionBrief).toContain("Fix the deploy pipeline");
  });
});
