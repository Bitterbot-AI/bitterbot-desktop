import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ComputeBackend,
  ComputeJobSummary,
  ComputeSnapshot,
  ComputeWorker,
} from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import { resetComputeEpisodesForTest } from "./episodes.js";
import {
  COMPUTE_NUDGE_COOLDOWN_MS,
  COMPUTE_NUDGE_HOURLY_CAP,
  type ComputeNudge,
  nudgeCompute,
  registerComputeNudgeSink,
  resetComputeNudgesForTest,
} from "./nudges.js";
import { resetComputeStateForTest } from "./state.js";
import { type ComputeWatcher, startComputeWatcher } from "./watcher.js";

const NOW = 1_700_000_000_000;

describe("compute nudges are bounded (PLAN-57 Phase 6)", () => {
  afterEach(() => resetComputeNudgesForTest());

  it("does nothing without a sink or when disabled", () => {
    expect(nudgeCompute({ kind: "success", reason: "x", now: NOW })).toBe(false);
    const sink = vi.fn();
    registerComputeNudgeSink(sink);
    expect(nudgeCompute({ kind: "success", reason: "x", enabled: false, now: NOW })).toBe(false);
    expect(sink).not.toHaveBeenCalled();
  });

  it("allows one nudge per kind per cooldown, caps the rolling hour, and survives a throwing sink", () => {
    const seen: ComputeNudge[] = [];
    registerComputeNudgeSink((n) => {
      seen.push(n);
    });
    expect(nudgeCompute({ kind: "success", reason: "job a", now: NOW })).toBe(true);
    expect(nudgeCompute({ kind: "success", reason: "job b", now: NOW + 1000 })).toBe(false);
    expect(nudgeCompute({ kind: "setback", reason: "worker", now: NOW + 1000 })).toBe(true);
    expect(
      nudgeCompute({ kind: "success", reason: "job c", now: NOW + COMPUTE_NUDGE_COOLDOWN_MS }),
    ).toBe(true);
    expect(
      nudgeCompute({
        kind: "setback",
        reason: "again",
        now: NOW + COMPUTE_NUDGE_COOLDOWN_MS + 1000,
      }),
    ).toBe(true);
    expect(seen.map((n) => n.reason)).toEqual(["job a", "worker", "job c", "again"]);
    expect(seen).toHaveLength(COMPUTE_NUDGE_HOURLY_CAP);
    // Two kinds at one per cooldown is exactly the hourly cap; nothing more fits
    // until the oldest ages out of the rolling hour.
    expect(nudgeCompute({ kind: "success", reason: "capped", now: NOW + 59 * 60_000 })).toBe(false);
    expect(nudgeCompute({ kind: "success", reason: "aged out", now: NOW + 60 * 60_000 })).toBe(
      true,
    );
    registerComputeNudgeSink(() => {
      throw new Error("boom");
    });
    expect(() =>
      nudgeCompute({ kind: "success", reason: "x", now: NOW + 10 * 60 * 60_000 }),
    ).not.toThrow();
  });
});

describe("the watcher nudges on owner-visible successes and setbacks", () => {
  let store: ComputeDeliveryStore;
  let w: ComputeWatcher | null = null;
  const jobs: ComputeJobSummary[] = [];
  const workers: ComputeWorker[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const nudges: ComputeNudge[] = [];
  const clock = { now: NOW };
  let reachable = true;

  function worker(id: string, online = true): ComputeWorker {
    return {
      id,
      online,
      paused: false,
      gpu: false,
      cpuThreads: 2,
      memoryMib: 512,
      pools: ["lab"],
      projects: [],
      modes: ["private"],
    };
  }
  function job(over: Partial<ComputeJobSummary> & { id: string }): ComputeJobSummary {
    return {
      status: "running",
      mode: "private",
      scope: "lab",
      workload: "sha256",
      items: 2,
      attempts: 1,
      ...over,
    };
  }
  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }
  async function runTimers() {
    for (const t of timers.splice(0)) {
      t.fn();
      await flush();
    }
  }

  beforeEach(() => {
    resetComputeStateForTest();
    resetComputeEpisodesForTest();
    resetComputeNudgesForTest();
    store = ComputeDeliveryStore.inMemory();
    jobs.length = 0;
    workers.length = 0;
    timers.length = 0;
    nudges.length = 0;
    clock.now = NOW;
    reachable = true;
    registerComputeNudgeSink((n) => {
      nudges.push(n);
    });
  });

  afterEach(() => {
    w?.stop();
    w = null;
    store.close();
    resetComputeNudgesForTest();
  });

  async function start(over: { nudges?: boolean } = {}) {
    let version = 0;
    const backend: ComputeBackend = {
      snapshot: async (): Promise<ComputeSnapshot> => ({
        version: ++version,
        asOf: clock.now,
        reachable,
        pools: [],
        workers: workers.slice(),
        jobs: jobs.slice(),
      }),
      jobs: async () => jobs.slice(),
      job: async (id) => jobs.find((j) => j.id === id) ?? null,
      result: async () => null,
    };
    w = startComputeWatcher({
      backend,
      store,
      ownerSessionKey: () => "agent:main:main",
      wakeBudgetPerHour: 20,
      nudges: over.nudges,
      enqueue:
        vi.fn() as unknown as typeof import("../../infra/system-events.js").enqueueSystemEvent,
      wake: vi.fn() as unknown as (o: { reason: string }) => void,
      now: () => clock.now,
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t as { fn: () => void; ms: number });
        if (i >= 0) {
          timers.splice(i, 1);
        }
      },
      subscribeHeartbeat: () => () => undefined,
    });
    await flush();
    await runTimers();
    return w;
  }

  it("lifts on a success it saw in flight, not on one first seen finished, and never for internal jobs", async () => {
    store.recordOrigin("old", "agent", "agent:main:main", 1);
    store.recordOrigin("live", "owner", null, 1);
    store.recordOrigin("int", "internal", null, 1);
    jobs.push(
      job({ id: "old", status: "succeeded" }),
      job({ id: "live", status: "running" }),
      job({ id: "int", status: "running" }),
    );
    await start();
    // Startup reconcile delivered "old" without a nudge.
    expect(nudges).toEqual([]);
    jobs.splice(
      0,
      jobs.length,
      job({ id: "old", status: "succeeded" }),
      job({ id: "live", status: "succeeded" }),
      job({ id: "int", status: "succeeded" }),
    );
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges.map((n) => [n.kind, n.reason])).toEqual([["success", "job live"]]);
    // A job that appears already succeeded (a refresh during an outage) does not lift.
    store.recordOrigin("late", "owner", null, 1);
    jobs.push(job({ id: "late", status: "succeeded" }));
    clock.now += COMPUTE_NUDGE_COOLDOWN_MS;
    await w!.pollOnce();
    expect(nudges).toHaveLength(1);
  });

  it("rises when a worker drops out or the coordinator goes away, once per cooldown", async () => {
    workers.push(worker("w1"), worker("w2"), worker("w3"));
    await start();
    expect(nudges).toEqual([]);
    // w2 goes offline; w3 leaves the pool altogether (not a setback).
    workers.splice(0, workers.length, worker("w1"), worker("w2", false));
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges.map((n) => [n.kind, n.reason])).toEqual([["setback", "worker offline: w2"]]);
    // Another loss inside the cooldown is absorbed.
    workers.splice(0, workers.length, worker("w1", false), worker("w2", false));
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges).toHaveLength(1);
    // After an idle stretch the first poll only rebuilds the baseline.
    workers.splice(0, workers.length, worker("w1"), worker("w2"));
    clock.now += COMPUTE_NUDGE_COOLDOWN_MS;
    await w!.pollOnce();
    workers.splice(0, workers.length, worker("w1", false), worker("w2", false));
    clock.now += 2 * 60_000;
    await w!.pollOnce();
    expect(nudges).toHaveLength(1);
    // A fresh baseline, then the coordinator goes away: one setback, and
    // while it is away worker lists are not compared.
    clock.now += 1000;
    await w!.pollOnce();
    reachable = false;
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges.at(-1)).toMatchObject({ kind: "setback", reason: "coordinator unreachable" });
    expect(nudges).toHaveLength(2);
    clock.now += 1000;
    await w!.pollOnce();
    reachable = true;
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges).toHaveLength(2);
  });

  it("is silent when compute.awareness.nudges is off", async () => {
    workers.push(worker("w1"));
    store.recordOrigin("j", "owner", null, 1);
    jobs.push(job({ id: "j", status: "running" }));
    await start({ nudges: false });
    workers.splice(0, 1, worker("w1", false));
    jobs.splice(0, 1, job({ id: "j", status: "succeeded" }));
    clock.now += 1000;
    await w!.pollOnce();
    expect(nudges).toEqual([]);
  });
});
