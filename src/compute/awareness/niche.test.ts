import { afterEach, describe, expect, it } from "vitest";
import type { ComputeSnapshot } from "./backend.js";
import { ComputeDeliveryStore } from "./deliveries.js";
import { computeNicheFacts, hasComputeActivity, renderComputeNicheInput } from "./niche.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;

const snapshot: ComputeSnapshot = {
  version: 1,
  asOf: NOW,
  reachable: true,
  pools: [
    {
      id: "lab",
      kind: "private",
      trust: "trusted",
      workersOnline: 2,
      workersTotal: 3,
      gpuWorkersOnline: 1,
    },
    {
      id: "guild",
      kind: "collective",
      trust: "untrusted",
      workersOnline: 5,
      workersTotal: 9,
      gpuWorkersOnline: 4,
    },
  ],
  workers: [],
  jobs: [],
};

describe("compute Niche facts (PLAN-57 §4.7)", () => {
  let store: ComputeDeliveryStore;
  afterEach(() => store?.close());

  it("is empty and quiet on a node with nothing", () => {
    store = ComputeDeliveryStore.inMemory();
    const f = computeNicheFacts({ store, snapshot: null, now: NOW });
    expect(hasComputeActivity(f)).toBe(false);
    expect(f).toMatchObject({
      windowDays: 7,
      jobs: { total: 0, successRate: null },
      reachable: null,
    });
    expect(renderComputeNicheInput(f)[1]).toBe("Pools: none joined (local machine only).");
  });

  it("summarises the week from the delivery and ledger tables", () => {
    store = ComputeDeliveryStore.inMemory();
    const within = NOW - 2 * DAY;
    const old = NOW - 9 * DAY;
    for (const [id, origin] of [
      ["a", "agent"],
      ["b", "agent"],
      ["c", "owner"],
      ["d", "owner"],
      ["e", "internal"],
      ["z", "agent"],
    ] as const) {
      store.recordOrigin(id, origin, null, within);
    }
    store.createDelivery("a", "succeeded", "s", within);
    store.createDelivery("b", "failed", "s", within);
    store.createDelivery("c", "succeeded", "s", within);
    store.createDelivery("d", "cancelled", "s", within);
    store.createDelivery("e", "succeeded", "s", within);
    store.createDelivery("z", "succeeded", "s", old);
    // An awaiting_payment delivery is not an outcome.
    store.createDelivery("a", "awaiting_payment", "s", within - 1);
    const ledger = store.ledger();
    const base = {
      profileKey: "p",
      jobId: null,
      receiptHash: null,
      reason: null,
      workerId: "w",
      poolId: "lab",
    };
    ledger.record({
      ...base,
      ts: within,
      route: "pool",
      trust: "trusted",
      cls: "personal",
      items: 40,
      durationMs: 2000,
    });
    ledger.record({
      ...base,
      ts: within,
      route: "pool",
      trust: "untrusted",
      cls: "normal",
      items: 20,
      durationMs: 1000,
      poolId: "guild",
    });
    ledger.record({
      ...base,
      ts: within,
      route: "local",
      trust: null,
      cls: "confidential",
      items: 10,
      durationMs: 5000,
      poolId: null,
      workerId: "local",
    });
    ledger.record({
      ...base,
      ts: within,
      route: "fallback",
      trust: null,
      cls: "normal",
      items: 5,
      durationMs: 100,
      reason: "timeout",
    });
    ledger.record({
      ...base,
      ts: old,
      route: "pool",
      trust: "trusted",
      cls: "personal",
      items: 999,
      durationMs: 1,
    });
    ledger.recordPayment({
      ts: within,
      jobId: "c",
      quoteHash: "q",
      amountUsdc: 0.75,
      payee: "0x",
      outcome: "funded",
      reason: null,
      reviewId: null,
      decidedBy: "v",
      via: "cli",
      txHash: "0x1",
    });
    ledger.recordPayment({
      ts: within,
      jobId: "d",
      quoteHash: "q",
      amountUsdc: 9,
      payee: "0x",
      outcome: "refused",
      reason: "over_cap",
      reviewId: null,
      decidedBy: "v",
      via: "cli",
      txHash: null,
    });

    const f = computeNicheFacts({ store, snapshot, now: NOW });
    expect(hasComputeActivity(f)).toBe(true);
    // The internal job "e" is not a consumed job; the old job "z" is outside the window.
    expect(f.jobs).toEqual({
      total: 4,
      byOrigin: { agent: 2, owner: 2 },
      byOutcome: { succeeded: 2, failed: 1, cancelled: 1 },
      successRate: 0.67,
    });
    expect(f.embeddings).toMatchObject({
      batches: 4,
      items: 75,
      pool: 2,
      local: 1,
      fallback: 1,
      poolByClassTrust: { "personal@trusted": 1, "normal@untrusted": 1 },
      poolItemsPerSecond: 20,
      localItemsPerSecond: 2,
      policyViolations: 0,
    });
    expect(f.payments).toEqual({ funded: 1, fundedUsdc: 0.75, refused: 1 });
    expect(f.pools.map((p) => `${p.id}:${p.trust}:${p.workersOnline}/${p.workersTotal}`)).toEqual([
      "lab:trusted:2/3",
      "guild:untrusted:5/9",
    ]);
    const lines = renderComputeNicheInput(f);
    expect(lines[0]).toBe("## Input: Compute (last 7 days)");
    expect(lines.join("\n")).toContain("lab (private, trusted, 2/3 workers online)");
    expect(lines.join("\n")).toContain(
      "Jobs consumed: 4 (agent 2, owner 2); outcomes: succeeded 2, failed 1, cancelled 1; success rate 67%",
    );
    expect(lines.join("\n")).toContain(
      "pool batches by class@trust: personal@trusted 1, normal@untrusted 1",
    );
    expect(lines.join("\n")).toContain(
      "Paid compute: 1 job(s) funded by the owner, 0.75 USDC; 1 funding request(s) refused",
    );
    // Nothing in the block names a secret-bearing field.
    expect(lines.join("\n")).not.toMatch(/token|rpc|escrow|0x1/i);
  });

  it("says when the coordinator was unreachable", () => {
    store = ComputeDeliveryStore.inMemory();
    const f = computeNicheFacts({ store, snapshot: { ...snapshot, reachable: false }, now: NOW });
    expect(renderComputeNicheInput(f)).toContain("Coordinator: unreachable at the last check.");
  });
});
