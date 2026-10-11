/**
 * PLAN-55 Phase 1: the run-completion hook that wires the correction
 * capture into the reply runner. Under test: the cheap gates run before the
 * memory manager is touched, the manager glue (canonicalFacts / ownerPinFact
 * / correctionLlmCall) is used, the line comes back, and a slow pass never
 * holds the reply past the timeout.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalFactsStore } from "../../memory/canonical-facts.js";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { pinFact } from "../../memory/owner-controls.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  getManager: vi.fn(),
  peekManager: vi.fn(),
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager: (params: unknown) => state.getManager(params),
  peekMemorySearchManager: (params: unknown) => state.peekManager(params),
}));

import { runCorrectionCaptureAfterTurn } from "./agent-runner-memory.js";

let db: DatabaseSync;
let store: CanonicalFactsStore;
const llm = vi.fn();

function followupRun(over: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    prompt: "x",
    enqueuedAt: Date.now(),
    run: {
      agentId: "main",
      sessionKey: "agent:main:main",
      senderIsOwner: true,
      sessionFile: "/nonexistent/session.jsonl",
      workspaceDir: "/srv/agents/acme",
      config: {},
      ...over,
    },
  } as unknown as FollowupRun;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  store = new CanonicalFactsStore(db);
  llm.mockReset();
  state.getManager.mockReset();
  state.peekManager.mockReset();
  state.peekManager.mockResolvedValue({ manager: null });
  state.getManager.mockResolvedValue({
    manager: {
      canonicalFacts: () => store,
      ownerPinFact: async (input: Parameters<typeof pinFact>[2]) => pinFact(db, store, input),
      correctionLlmCall: () => llm,
    },
    error: null,
  });
});

const base = {
  cfg: {},
  sessionKey: "agent:main:main",
  commandBody: "No, the deploy endpoint is api2.acme.com",
  replyText: "ok",
  isHeartbeat: false,
  chatType: "direct",
  runStartedAt: Date.now(),
};

describe("runCorrectionCaptureAfterTurn", () => {
  it("captures an owner correction through the manager and returns the line", async () => {
    llm.mockResolvedValue(
      JSON.stringify({
        facts: [{ key: "infra.deploy_endpoint", value: "api2.acme.com", correction: true }],
      }),
    );
    const line = await runCorrectionCaptureAfterTurn({ ...base, followupRun: followupRun() });
    expect(line).toBe("Memory updated: deploy endpoint = api2.acme.com");
    expect(state.getManager).toHaveBeenCalledWith({ cfg: {}, agentId: "main" });
    expect(llm).toHaveBeenCalledTimes(1);
    // The workspace basename is the project hint in the prompt.
    expect(llm.mock.calls[0]![0]).toContain('The current project is "acme"');
    expect(store.get("infra.deploy_endpoint")).toMatchObject({
      value: "api2.acme.com",
      source: "owner",
      // No readable transcript: the evidence falls back to nothing, never to a guess.
      evidenceRef: null,
    });
  });

  it("skips before touching the manager for heartbeats, guests, non-first-party sessions and incognito", async () => {
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        followupRun: followupRun(),
        isHeartbeat: true,
      }),
    ).toBeNull();
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        followupRun: followupRun({ senderIsOwner: false }),
      }),
    ).toBeNull();
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        sessionKey: "agent:main:cron:nightly",
        followupRun: followupRun({ sessionKey: "agent:main:cron:nightly" }),
      }),
    ).toBeNull();
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        cfg: { session: { memory: "off" } },
        followupRun: followupRun(),
      }),
    ).toBeNull();
    expect(
      await runCorrectionCaptureAfterTurn({
        ...base,
        cfg: { memory: { correction: { enabled: false } } },
        followupRun: followupRun(),
      }),
    ).toBeNull();
    expect(state.getManager).not.toHaveBeenCalled();
  });

  it("a turn without a corrective shape never opens the memory manager, only peeks at an open one", async () => {
    const plain = { ...base, commandBody: "check my wallet balance", followupRun: followupRun() };
    expect(await runCorrectionCaptureAfterTurn(plain)).toBeNull();
    expect(state.getManager).not.toHaveBeenCalled();
    expect(state.peekManager).toHaveBeenCalledWith({ cfg: {}, agentId: "main" });
    // With an already-open manager, the run's own agent writes are still reported.
    store.pin({ key: "identity.user.name", value: "Victor", source: "owner" });
    store.pin({ key: "identity.user.name", value: "Vic", source: "agent_pin" });
    state.peekManager.mockResolvedValue({
      manager: { canonicalFacts: () => store, correctionLlmCall: () => llm },
    });
    expect(await runCorrectionCaptureAfterTurn({ ...plain, runStartedAt: Date.now() - 50 })).toBe(
      "Memory: held for your confirmation: user name Victor -> Vic",
    );
    expect(llm).not.toHaveBeenCalled();
    expect(state.getManager).not.toHaveBeenCalled();
  });

  it("returns null without a ledger, and never throws when the manager fails", async () => {
    state.getManager.mockResolvedValueOnce({ manager: null, error: "memory off" });
    expect(await runCorrectionCaptureAfterTurn({ ...base, followupRun: followupRun() })).toBeNull();
    state.getManager.mockRejectedValueOnce(new Error("boom"));
    expect(await runCorrectionCaptureAfterTurn({ ...base, followupRun: followupRun() })).toBeNull();
  });

  it("does not hold the reply past the timeout", async () => {
    vi.useFakeTimers();
    try {
      llm.mockImplementation(() => new Promise(() => {}));
      const pending = runCorrectionCaptureAfterTurn({ ...base, followupRun: followupRun() });
      await vi.advanceTimersByTimeAsync(13_000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
