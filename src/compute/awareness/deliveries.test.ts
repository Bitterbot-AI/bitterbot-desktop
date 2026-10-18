import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputeDeliveryStore, resolveComputeDbPath } from "./deliveries.js";

describe("ComputeDeliveryStore", () => {
  let store: ComputeDeliveryStore;
  afterEach(() => store?.close());

  it("resolves its default path under the state dir, with an env override", () => {
    const resolved = resolveComputeDbPath({ HOME: "/home/x" } as NodeJS.ProcessEnv);
    // Separator-agnostic: Windows resolves this under a drive letter with backslashes.
    expect(path.basename(resolved)).toBe("deliveries.sqlite");
    expect(path.basename(path.dirname(resolved))).toBe("compute");
    expect(
      resolveComputeDbPath({ BITTERBOT_COMPUTE_DB: "/tmp/x.sqlite" } as NodeJS.ProcessEnv),
    ).toBe("/tmp/x.sqlite");
  });

  it("records and upserts job origins, and lists internal ones", () => {
    store = ComputeDeliveryStore.inMemory();
    store.recordOrigin("j1", "owner", "agent:main:main", 1);
    store.recordOrigin("j2", "internal", null, 2);
    store.recordOrigin("j1", "agent", "agent:main:task-9", 3);
    expect(store.originOf("j1")).toMatchObject({
      origin: "agent",
      sessionKey: "agent:main:task-9",
    });
    expect(store.originOf("missing")).toBeNull();
    expect(store.internalJobIds()).toEqual(["j2"]);
    expect(store.pruneOrigins(10, 20)).toBe(2);
  });

  it("creates a delivery once per (job, transition)", () => {
    store = ComputeDeliveryStore.inMemory();
    expect(store.createDelivery("j1", "succeeded", "main", 10)).toBe(true);
    expect(store.createDelivery("j1", "succeeded", "main", 11)).toBe(false);
    expect(store.createDelivery("j1", "failed", "main", 12)).toBe(true);
    expect(store.hasDelivery("j1", "succeeded")).toBe(true);
    expect(store.pending()).toHaveLength(2);
  });

  it("marks delivered only what was enqueued before the heartbeat drained that session", () => {
    store = ComputeDeliveryStore.inMemory();
    store.createDelivery("early", "succeeded", "main", 1);
    store.markEnqueued("early", "succeeded", { now: 5 });
    store.createDelivery("late", "succeeded", "main", 1);
    store.markEnqueued("late", "succeeded", { now: 50 });
    store.createDelivery("other", "succeeded", "agent:main:task-1", 1);
    store.markEnqueued("other", "succeeded", { now: 5 });
    store.createDelivery("never", "succeeded", "main", 1);
    expect(store.markDeliveredUpTo("main", 20)).toBe(1);
    const pending = store
      .pending()
      .map((r) => r.jobId)
      .toSorted();
    expect(pending).toEqual(["late", "never", "other"]);
  });

  it("tracks deferred rows and reports the ones that are due", () => {
    store = ComputeDeliveryStore.inMemory();
    store.createDelivery("d1", "succeeded", "main", 1);
    store.markEnqueued("d1", "succeeded", { now: 2, deferredUntil: 100 });
    store.createDelivery("d2", "succeeded", "main", 1);
    store.markEnqueued("d2", "succeeded", { now: 2, deferredUntil: 500 });
    expect(store.deferredCount()).toBe(2);
    expect(store.dueDeferred(150).map((r) => r.jobId)).toEqual(["d1"]);
    store.markEnqueued("d1", "succeeded", { now: 150 });
    expect(store.deferredCount()).toBe(1);
    expect(store.pending().find((r) => r.jobId === "d1")?.attempts).toBe(2);
    store.markDeliveredUpTo("main", 200);
    expect(store.pending().map((r) => r.jobId)).toEqual([]);
    expect(store.pruneDelivered(0, 1000)).toBe(2);
  });
});
