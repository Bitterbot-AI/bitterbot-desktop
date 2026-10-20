import { afterEach, describe, expect, it } from "vitest";
import { ComputeDeliveryStore } from "./deliveries.js";

describe("ComputeDeliveryStore task linkage columns", () => {
  let store: ComputeDeliveryStore;
  afterEach(() => store?.close());

  it("stores task and wakeup ids with an origin and keeps them across a re-record without them", () => {
    store = ComputeDeliveryStore.inMemory();
    store.recordOrigin("j1", "agent", "agent:main:task-3", {
      now: 1,
      taskId: "t3",
      wakeupJobId: "wk-1",
    });
    expect(store.originOf("j1")).toMatchObject({
      origin: "agent",
      sessionKey: "agent:main:task-3",
      taskId: "t3",
      wakeupJobId: "wk-1",
    });
    // The tool records the plain origin first and the link second; the reverse order must not lose the link.
    store.recordOrigin("j1", "agent", "agent:main:task-3", 2);
    expect(store.originOf("j1")).toMatchObject({ taskId: "t3", wakeupJobId: "wk-1" });
  });

  it("leaves task fields null for owner and internal jobs", () => {
    store = ComputeDeliveryStore.inMemory();
    store.recordOrigin("o1", "owner", null, 5);
    expect(store.originOf("o1")).toMatchObject({ taskId: null, wakeupJobId: null });
  });
});
