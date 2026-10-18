import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputeBackend, ComputeJobSummary } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import { resetComputeStateForTest } from "./state.js";
import { startComputeWatcher } from "./watcher.js";

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("compute watcher task linkage", () => {
  const store = ComputeDeliveryStore.inMemory();
  afterEach(() => resetComputeStateForTest());

  it("completes the task link exactly once when a linked agent job finishes", async () => {
    const job: ComputeJobSummary = {
      id: "lj",
      status: "succeeded",
      mode: "private",
      scope: "lab",
      workload: "sha256",
      items: 2,
      attempts: 1,
    };
    const backend: ComputeBackend = {
      snapshot: async () => ({
        version: 1,
        asOf: 0,
        reachable: true,
        pools: [],
        workers: [],
        jobs: [job],
      }),
      jobs: async () => [job],
      job: async () => job,
      result: async () => null,
    };
    store.recordOrigin("lj", "agent", "agent:main:task-9", { taskId: "t9", wakeupJobId: "wk-9" });
    const completeTaskLink = vi.fn(async () => undefined);
    const enqueue = vi.fn();
    const w = startComputeWatcher({
      backend,
      store,
      ownerSessionKey: () => "agent:main:main",
      enqueue:
        enqueue as unknown as typeof import("../../infra/system-events.js").enqueueSystemEvent,
      wake: () => undefined,
      setTimer: () => null,
      clearTimer: () => undefined,
      subscribeHeartbeat: () => () => undefined,
      completeTaskLink,
    });
    await flush();
    await w.pollOnce();
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toMatchObject({ sessionKey: "agent:main:task-9" });
    expect(completeTaskLink).toHaveBeenCalledTimes(1);
    expect(completeTaskLink).toHaveBeenCalledWith({ taskId: "t9", wakeupJobId: "wk-9", job });
    w.stop();
    store.close();
  });
});
