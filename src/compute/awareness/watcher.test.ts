import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatEventPayload } from "../../infra/heartbeat-events.js";
import type { ComputeBackend, ComputeJobSummary, ComputeSnapshot } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import { getComputeSnapshot, resetComputeStateForTest, resolveComputeStateBlock } from "./state.js";
import {
  COMPUTE_WAKE_REASON,
  formatTransition,
  startComputeWatcher,
  type ComputeWatcher,
} from "./watcher.js";

type Harness = {
  jobs: ComputeJobSummary[];
  credits: number;
  backend: ComputeBackend;
  store: ComputeDeliveryStore;
  enqueue: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  timers: Array<{ fn: () => void; ms: number }>;
  clock: { now: number };
  heartbeat: (evt: Partial<HeartbeatEventPayload>) => void;
  start: (over?: { wakeBudgetPerHour?: number }) => Promise<ComputeWatcher>;
  runTimers: () => Promise<void>;
};

function job(over: Partial<ComputeJobSummary> & { id: string }): ComputeJobSummary {
  return {
    status: "running",
    mode: "private",
    scope: "lab",
    workload: "sha256",
    items: 12,
    attempts: 1,
    worker: "w1",
    ...over,
  };
}

function harness(): Harness {
  const h: Partial<Harness> = {};
  let version = 0;
  h.jobs = [];
  h.credits = 100;
  h.clock = { now: 1_700_000_000_000 };
  h.timers = [];
  h.enqueue = vi.fn();
  h.wake = vi.fn();
  let listener: ((evt: HeartbeatEventPayload) => void) | null = null;
  h.heartbeat = (evt) => listener?.({ ts: h.clock!.now, status: "ok-empty", ...evt });
  h.store = ComputeDeliveryStore.inMemory();
  h.backend = {
    snapshot: async (): Promise<ComputeSnapshot> => ({
      version: ++version,
      asOf: h.clock!.now,
      reachable: true,
      credits: { available: h.credits!, reserved: 0, currency: "TEST_CREDIT" },
      pools: [
        {
          id: "lab",
          kind: "private",
          trust: "trusted",
          workersOnline: 1,
          workersTotal: 1,
          gpuWorkersOnline: 0,
        },
      ],
      workers: [],
      jobs: h.jobs!.slice(),
    }),
    jobs: async () => h.jobs!.slice(),
    job: async (id) => h.jobs!.find((j) => j.id === id) ?? null,
    result: async () => null,
  };
  h.start = async (over = {}) => {
    const w = startComputeWatcher({
      backend: h.backend!,
      store: h.store!,
      ownerSessionKey: () => "agent:main:main",
      wakeBudgetPerHour: over.wakeBudgetPerHour ?? 20,
      enqueue:
        h.enqueue as unknown as typeof import("../../infra/system-events.js").enqueueSystemEvent,
      wake: h.wake as unknown as (o: { reason: string }) => void,
      now: () => h.clock!.now,
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        h.timers!.push(t);
        return t;
      },
      clearTimer: (t) => {
        h.timers = h.timers!.filter((x) => x !== t);
      },
      subscribeHeartbeat: (l) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    });
    // startup: reconcile, then kick (schedules a 0 ms timer)
    await flush();
    await h.runTimers!();
    return w;
  };
  h.runTimers = async () => {
    const due = h.timers!.splice(0);
    for (const t of due) {
      t.fn();
      await flush();
    }
  };
  return h as Harness;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("compute watcher", () => {
  let h: Harness;
  let w: ComputeWatcher | null = null;
  beforeEach(() => {
    resetComputeStateForTest();
    h = harness();
  });
  afterEach(() => {
    w?.stop();
    w = null;
    h.store.close();
  });

  it("polls once at start and then stays idle when nothing is in flight", async () => {
    w = await h.start();
    expect(getComputeSnapshot()?.version).toBe(1);
    expect(w.isPolling()).toBe(false);
    expect(h.timers).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it("backs off from 2 s toward 30 s while a job runs, delivers its completion once, then goes idle", async () => {
    h.jobs = [job({ id: "j1" })];
    h.store.recordOrigin("j1", "owner", null);
    w = await h.start();
    expect(w.isPolling()).toBe(true);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      delays.push(h.timers[0].ms);
      await h.runTimers();
    }
    expect(delays).toEqual([3000, 4500, 6750, 10125]);
    expect(h.enqueue).not.toHaveBeenCalled();

    h.jobs = [job({ id: "j1", status: "succeeded", verification: "recomputed" })];
    await h.runTimers();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const [text, opts] = h.enqueue.mock.calls[0];
    expect(text).toBe(
      "[compute succeeded] Job j1 (sha256, 12 items) in lab on w1. Verification: recomputed.",
    );
    expect(opts).toEqual({ sessionKey: "agent:main:main", contextKey: "compute-job:j1:succeeded" });
    expect(h.wake).toHaveBeenCalledWith({ reason: COMPUTE_WAKE_REASON });
    expect(w.isPolling()).toBe(false);
    // The one-shot line reaches the state block, once.
    expect(resolveComputeStateBlock({ now: h.clock.now })).toContain(
      "last: j1 succeeded 0s_ago (sha256 x12 on w1, recomputed)",
    );

    // Another poll with the same terminal state: no second delivery.
    await w.pollOnce();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("routes agent-started jobs to their own session and never delivers internal jobs or unknown ones", async () => {
    h.jobs = [job({ id: "agentjob" }), job({ id: "internaljob" }), job({ id: "unknownjob" })];
    h.store.recordOrigin("agentjob", "agent", "agent:main:task-7");
    h.store.recordOrigin("internaljob", "internal", null);
    w = await h.start();
    h.jobs = h.jobs.map((j) => ({ ...j, status: "failed", error: "boom" }));
    await h.runTimers();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][1]).toMatchObject({ sessionKey: "agent:main:task-7" });
    expect(h.enqueue.mock.calls[0][0]).toContain("Error: boom");
  });

  it("never wakes on credit or worker changes alone", async () => {
    h.jobs = [job({ id: "j1" })];
    h.store.recordOrigin("j1", "owner", null);
    w = await h.start();
    h.credits = 1;
    await h.runTimers();
    await h.runTimers();
    expect(h.wake).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("defers beyond the wake budget, still enqueues, and retries when the budget resets", async () => {
    h.jobs = [job({ id: "a" }), job({ id: "b" })];
    h.store.recordOrigin("a", "owner", null);
    h.store.recordOrigin("b", "owner", null);
    w = await h.start({ wakeBudgetPerHour: 1 });
    h.jobs = [job({ id: "a", status: "succeeded" }), job({ id: "b", status: "succeeded" })];
    await h.runTimers();
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.store.deferredCount()).toBe(1);
    expect(resolveComputeStateBlock({ now: h.clock.now })).toContain("waiting: 1 completion held");
    // Deferred work keeps the watcher polling so the retry can fire.
    expect(w.isPolling()).toBe(true);
    h.clock.now += 61 * 60_000;
    await h.runTimers();
    expect(h.wake).toHaveBeenCalledTimes(2);
    expect(h.store.deferredCount()).toBe(0);
  });

  it("marks deliveries as delivered when a heartbeat turn completes for that session", async () => {
    h.jobs = [job({ id: "j1", status: "succeeded" })];
    h.store.recordOrigin("j1", "owner", null);
    w = await h.start();
    expect(h.store.pending()).toHaveLength(1);
    h.heartbeat({ status: "skipped" });
    expect(h.store.pending()).toHaveLength(1);
    h.clock.now += 1000;
    h.heartbeat({ status: "ok-token" });
    expect(h.store.pending()).toHaveLength(0);
  });

  it("reconciles at start: a job that finished while the gateway was down is reported once", async () => {
    h.store.recordOrigin("old", "owner", null);
    h.jobs = [job({ id: "old", status: "succeeded" })];
    w = await h.start();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    // Simulate a restart with the same durable store: no second report.
    w.stop();
    h.enqueue.mockClear();
    h.wake.mockClear();
    w = await h.start();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("retries the startup reconcile with backoff while the coordinator is still booting", async () => {
    h.store.recordOrigin("old", "owner", null);
    h.jobs = [job({ id: "old", status: "succeeded" })];
    let failures = 2;
    const jobs = h.backend.jobs;
    h.backend.jobs = async (q) => {
      if (failures-- > 0) {
        throw new Error("fetch failed");
      }
      return jobs(q);
    };
    // start(): attempt 1 fails and arms a 2 s retry, which start() then runs:
    // attempt 2 fails and arms a 4 s retry. Nothing is reported yet.
    w = await h.start();
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.timers.map((t) => t.ms)).toEqual([4000]);
    // Attempt 3 reaches the coordinator: the old job is reported once and polling starts.
    await h.runTimers();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.timers.map((t) => t.ms)).toEqual([0]);
  });

  it("stop() during the startup backoff ends the retries", async () => {
    h.backend.jobs = async () => {
      throw new Error("fetch failed");
    };
    w = await h.start();
    expect(h.timers.map((t) => t.ms)).toEqual([4000]);
    w.stop();
    await h.runTimers();
    expect(h.timers).toHaveLength(0);
  });

  it("kick() restarts polling immediately after a submit", async () => {
    w = await h.start();
    expect(w.isPolling()).toBe(false);
    h.jobs = [job({ id: "new" })];
    h.store.recordOrigin("new", "agent", "agent:main:task-1");
    w.kick();
    expect(h.timers[0].ms).toBe(0);
    await h.runTimers();
    expect(w.isPolling()).toBe(true);
  });
});

describe("formatTransition", () => {
  it("tells the agent it cannot fund an awaiting_payment job", () => {
    const text = formatTransition(
      job({
        id: "p",
        status: "awaiting_payment",
        mode: "paid_usdc",
        scope: undefined,
        awaitingUsdc: 0.4,
      }),
    );
    expect(text).toContain("waits for the owner to fund it");
    expect(text).toContain("You cannot fund it");
    expect(text).toContain("0.4 test USDC");
  });
});
