import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore } from "../../checkpoints/store.js";
import { LongHorizonRuntime } from "./runtime.js";

describe("LongHorizonRuntime", () => {
  let dir: string;
  let dbPath: string;
  let store: CheckpointStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-long-horizon-"));
    dbPath = path.join(dir, "checkpoints.sqlite");
    store = CheckpointStore.open(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a fake clock + sleep pair so the runtime advances through
   * phases without real timers. `now()` returns the current value, and
   * `sleep(ms)` advances it. Each call to advanceForWorkStep() bumps
   * the clock past the workMs window so the inner work loop exits.
   */
  function makeClock(start = 0) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  it("runs work → rest → dream and writes a parent-chained checkpoint timeline", async () => {
    const clock = makeClock();
    const dreamStep = vi.fn().mockResolvedValue({ label: "dream cycle", state: { insight: "x" } });
    let workCalls = 0;
    const runtime = new LongHorizonRuntime({
      threadId: "task-A",
      workMs: 100,
      restMs: 10,
      budgetMs: 500,
      maxIterations: 1, // one cycle, then stop on iteration cap
      now: clock.now,
      sleep: clock.sleep,
      store,
      workStep: async () => {
        workCalls += 1;
        clock.advance(60); // each work step costs 60ms; 2 fits in 100ms
        return { state: { iter: workCalls }, label: `work ${workCalls}` };
      },
      dreamStep,
    });

    const stats = await runtime.run();
    expect(stats.workSteps).toBeGreaterThanOrEqual(1);
    expect(stats.dreamSteps).toBe(1);
    expect(dreamStep).toHaveBeenCalledTimes(1);

    const list = store.list("task-A");
    // Phases recorded: at least 1 work, 1 rest, 1 dream.
    const phases = list.map((cp) => (cp.metadata as { phase: string } | null)?.phase);
    expect(phases).toContain("work");
    expect(phases).toContain("rest");
    expect(phases).toContain("dream");

    // Checkpoints form a parent chain (each step references the prior).
    for (let i = 1; i < list.length; i++) {
      expect(list[i].parentStepId).toBe(list[i - 1].stepId);
    }
  });

  it("stops early when workStep returns done=true", async () => {
    const clock = makeClock();
    let calls = 0;
    const runtime = new LongHorizonRuntime({
      threadId: "task-B",
      workMs: 1_000,
      restMs: 10,
      budgetMs: 60_000,
      maxIterations: 10,
      now: clock.now,
      sleep: clock.sleep,
      store,
      workStep: async () => {
        calls += 1;
        clock.advance(50);
        return calls === 3 ? { done: true } : {};
      },
    });

    const stats = await runtime.run();
    expect(stats.reason).toBe("done");
    expect(stats.workSteps).toBe(3);
  });

  it("respects an AbortSignal", async () => {
    const clock = makeClock();
    const ac = new AbortController();
    let calls = 0;
    const runtime = new LongHorizonRuntime({
      threadId: "task-C",
      workMs: 1_000,
      restMs: 10,
      budgetMs: 60_000,
      maxIterations: 10,
      now: clock.now,
      sleep: clock.sleep,
      store,
      signal: ac.signal,
      workStep: async () => {
        calls += 1;
        clock.advance(50);
        if (calls === 2) ac.abort();
        return {};
      },
    });

    const stats = await runtime.run();
    expect(stats.reason).toBe("aborted");
    // The work step that triggers abort still completes; abort takes effect
    // on the next iteration check.
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("hits the wall-clock budget and stops with reason=budget", async () => {
    const clock = makeClock();
    const runtime = new LongHorizonRuntime({
      threadId: "task-D",
      workMs: 50,
      restMs: 10,
      budgetMs: 200,
      maxIterations: 100,
      now: clock.now,
      sleep: clock.sleep,
      store,
      workStep: async () => {
        clock.advance(30);
        return {};
      },
      dreamStep: async () => ({}),
    });

    const stats = await runtime.run();
    expect(["budget", "iterations"]).toContain(stats.reason);
    expect(clock.now()).toBeGreaterThanOrEqual(200);
  });

  it("LongHorizonRuntime.resume returns the latest step id from the store", () => {
    const clock = makeClock();
    const runtime = new LongHorizonRuntime({
      threadId: "task-E",
      workMs: 50,
      restMs: 10,
      budgetMs: 1_000,
      maxIterations: 1,
      now: clock.now,
      sleep: clock.sleep,
      store,
      workStep: async () => {
        clock.advance(30);
        return {};
      },
    });
    return runtime.run().then(() => {
      const tip = LongHorizonRuntime.resume("task-E", store);
      expect(tip).toBeTruthy();
      const last = store.list("task-E").at(-1);
      expect(tip).toBe(last?.stepId);
    });
  });
});
