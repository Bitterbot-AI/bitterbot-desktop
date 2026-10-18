import { afterEach, describe, expect, it } from "vitest";
import { ComputeDeliveryStore } from "./deliveries.js";

describe("ComputeLedger", () => {
  let store: ComputeDeliveryStore;
  afterEach(() => store?.close());

  it("records rows and summarises by route, class, trust and reason", () => {
    store = ComputeDeliveryStore.inMemory();
    const ledger = store.ledger();
    const common = { profileKey: "p", jobId: null, receiptHash: null };
    ledger.record({
      ts: 100,
      route: "local",
      poolId: null,
      workerId: null,
      trust: null,
      cls: "personal",
      items: 10,
      durationMs: 1000,
      reason: "no local timing yet",
      ...common,
    });
    ledger.record({
      ts: 200,
      route: "pool",
      poolId: "lab",
      workerId: "gpu-1",
      trust: "trusted",
      cls: "normal",
      items: 40,
      durationMs: 500,
      reason: null,
      ...common,
      jobId: "j1",
      receiptHash: "r",
    });
    ledger.record({
      ts: 300,
      route: "pool",
      poolId: "lab",
      workerId: "gpu-1",
      trust: "trusted",
      cls: "personal",
      items: 20,
      durationMs: 500,
      reason: null,
      ...common,
      jobId: "j2",
    });
    ledger.record({
      ts: 400,
      route: "fallback",
      poolId: "lab",
      workerId: "gpu-1",
      trust: "trusted",
      cls: "normal",
      items: 5,
      durationMs: 800,
      reason: "digest_mismatch",
      ...common,
      jobId: "j3",
    });
    ledger.record({
      ts: 50,
      route: "fallback",
      poolId: "lab",
      workerId: "gpu-1",
      trust: "trusted",
      cls: "normal",
      items: 5,
      durationMs: 800,
      reason: "policy_violation",
      ...common,
    });
    const s = ledger.summary(100);
    expect(s.batches).toBe(4);
    expect(s.items).toBe(75);
    expect(s.byRoute.pool).toEqual({ batches: 2, items: 60 });
    expect(s.poolByClassTrust).toEqual({ "normal@trusted": 1, "personal@trusted": 1 });
    expect(s.fallbacksByReason).toEqual({ digest_mismatch: 1 });
    expect(s.policyViolations).toBe(0);
    expect(s.poolItemsPerSecond).toBe(60);
    expect(s.localItemsPerSecond).toBe(10);
    expect(ledger.summary(0).policyViolations).toBe(1);
    expect(ledger.recent(2).map((r) => r.ts)).toEqual([50, 400]);
    expect(ledger.prune(0, 250)).toBe(3);
    expect(ledger.summary(0).batches).toBe(2);
  });
});
