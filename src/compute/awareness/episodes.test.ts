import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputeBackend, ComputeJobSummary, ComputeSnapshot } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import {
  type ComputeEpisode,
  emitComputeEpisode,
  episodeFromJob,
  formatComputeEpisode,
  registerComputeEpisodeSink,
  resetComputeEpisodesForTest,
} from "./episodes.js";
import { resetComputeStateForTest } from "./state.js";
import { type ComputeWatcher, startComputeWatcher } from "./watcher.js";

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

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("compute episodes (PLAN-57 §4.7)", () => {
  afterEach(() => resetComputeEpisodesForTest());

  it("formats a job as one readable sentence", () => {
    const ep = episodeFromJob(
      job({ id: "j-42", status: "succeeded", items: 200, verification: "recomputed" }),
      { origin: "agent", sessionKey: "agent:main:main" },
      Date.UTC(2026, 9, 18, 14, 2),
    );
    expect(ep.sessionKey).toBe("agent:main:main");
    expect(formatComputeEpisode(ep)).toBe(
      "Compute job j-42 (sha256 x200, private in lab on worker w1) succeeded, recorded 2026-10-18 14:02 UTC; started by the agent. Verification: recomputed.",
    );
    const failed = episodeFromJob(
      job({
        id: "j-43",
        status: "failed",
        scope: undefined,
        worker: undefined,
        error: `${"x".repeat(300)}. Second sentence with a host name in it.`,
      }),
      { origin: "owner" },
      0,
    );
    // Only the first clause, clipped, is kept.
    expect(failed.error).toHaveLength(80);
    expect(failed.sessionKey).toBeNull();
    expect(formatComputeEpisode(failed)).toContain("started by the owner. Error: xxx");
    expect(formatComputeEpisode(failed)).not.toContain("host name");
  });

  it("emits only terminal statuses, only to a registered sink, and never throws", async () => {
    const sink = vi.fn(async () => undefined);
    const ep = episodeFromJob(job({ id: "j1", status: "succeeded" }), { origin: "agent" }, 1);
    emitComputeEpisode(ep);
    expect(sink).not.toHaveBeenCalled();
    registerComputeEpisodeSink(sink);
    emitComputeEpisode(
      episodeFromJob(job({ id: "j1", status: "awaiting_payment" }), { origin: "agent" }, 1),
    );
    emitComputeEpisode(
      episodeFromJob(job({ id: "j1", status: "running" }), { origin: "agent" }, 1),
    );
    expect(sink).not.toHaveBeenCalled();
    emitComputeEpisode(ep);
    expect(sink).toHaveBeenCalledWith(ep);
    registerComputeEpisodeSink(() => {
      throw new Error("boom");
    });
    expect(() => emitComputeEpisode(ep)).not.toThrow();
    registerComputeEpisodeSink(async () => {
      throw new Error("later");
    });
    expect(() => emitComputeEpisode(ep)).not.toThrow();
    await flush();
  });
});

describe("the watcher emits an episode per delivered terminal transition", () => {
  let store: ComputeDeliveryStore;
  let w: ComputeWatcher | null = null;
  const jobs: ComputeJobSummary[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const episodes: ComputeEpisode[] = [];

  beforeEach(() => {
    resetComputeStateForTest();
    resetComputeEpisodesForTest();
    store = ComputeDeliveryStore.inMemory();
    jobs.length = 0;
    timers.length = 0;
    episodes.length = 0;
    registerComputeEpisodeSink((ep) => {
      episodes.push(ep);
    });
  });

  afterEach(() => {
    w?.stop();
    w = null;
    store.close();
    resetComputeEpisodesForTest();
  });

  async function runTimers() {
    for (const t of timers.splice(0)) {
      t.fn();
      await flush();
    }
  }

  async function start() {
    let version = 0;
    const backend: ComputeBackend = {
      snapshot: async (): Promise<ComputeSnapshot> => ({
        version: ++version,
        asOf: 1_700_000_000_000,
        reachable: true,
        pools: [],
        workers: [],
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
      enqueue:
        vi.fn() as unknown as typeof import("../../infra/system-events.js").enqueueSystemEvent,
      wake: vi.fn() as unknown as (o: { reason: string }) => void,
      now: () => 1_700_000_000_000,
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

  it("records agent and owner jobs once, skips internal and non-terminal ones", async () => {
    store.recordOrigin("a1", "agent", "agent:main:main", 1);
    store.recordOrigin("o1", "owner", null, 1);
    store.recordOrigin("i1", "internal", null, 1);
    store.recordOrigin("p1", "agent", "agent:main:main", 1);
    jobs.push(
      job({ id: "a1", status: "succeeded" }),
      job({ id: "o1", status: "failed", error: "oom" }),
      job({ id: "i1", status: "succeeded" }),
      job({ id: "p1", status: "awaiting_payment", awaitingUsdc: 0.5 }),
    );
    await start();
    expect(
      episodes.map((e) => `${e.jobId}:${e.status}:${e.origin}:${e.sessionKey}`).toSorted(),
    ).toEqual(["a1:succeeded:agent:agent:main:main", "o1:failed:owner:agent:main:main"]);
    // A second poll with the same statuses adds nothing.
    await w!.pollOnce();
    expect(episodes).toHaveLength(2);
    // The paid job finishing later becomes its own episode.
    jobs.splice(
      jobs.findIndex((j) => j.id === "p1"),
      1,
      job({ id: "p1", status: "succeeded", mode: "paid_usdc" }),
    );
    await w!.pollOnce();
    expect(episodes.at(-1)).toMatchObject({ jobId: "p1", status: "succeeded", mode: "paid_usdc" });
    expect(store.jobOutcomes(0)).toEqual([
      { origin: "agent", transition: "succeeded", jobs: 2 },
      { origin: "owner", transition: "failed", jobs: 1 },
    ]);
  });
});
