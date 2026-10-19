import { afterEach, describe, expect, it } from "vitest";
import { ComputeDeliveryStore } from "./deliveries.js";

describe("ComputeLedger payments (PLAN-57 §4.8)", () => {
  let store: ComputeDeliveryStore;
  afterEach(() => store?.close());

  it("records funding attempts and summarises them, counting agent-origin refusals apart", () => {
    store = ComputeDeliveryStore.inMemory();
    const ledger = store.ledger();
    const base = {
      quoteHash: "q",
      payee: "0xp",
      reviewId: null,
      decidedBy: "v",
      via: "cli",
      txHash: null,
    };
    ledger.recordPayment({
      ...base,
      ts: 1000,
      jobId: "a",
      amountUsdc: 1.25,
      outcome: "funded",
      reason: null,
      txHash: "0x1",
    });
    ledger.recordPayment({
      ...base,
      ts: 2000,
      jobId: "b",
      amountUsdc: 0.5,
      outcome: "funded",
      reason: null,
      txHash: "0x2",
    });
    ledger.recordPayment({
      ...base,
      ts: 3000,
      jobId: "c",
      amountUsdc: 0.5,
      outcome: "refused",
      reason: "agent_origin",
    });
    ledger.recordPayment({
      ...base,
      ts: 4000,
      jobId: "d",
      amountUsdc: 9,
      outcome: "refused",
      reason: "over_cap",
    });
    ledger.recordPayment({
      ...base,
      ts: 5000,
      jobId: "e",
      amountUsdc: 0.1,
      outcome: "failed",
      reason: "reverted",
    });
    // A pending row settled by a later row for the same job is not counted; an orphan is.
    ledger.recordPayment({
      ...base,
      ts: 900,
      jobId: "a",
      amountUsdc: 1.25,
      outcome: "pending",
      reason: null,
    });
    ledger.recordPayment({
      ...base,
      ts: 6000,
      jobId: "f",
      amountUsdc: 0.3,
      outcome: "pending",
      reason: null,
    });
    expect(ledger.paymentSummary(0)).toEqual({
      since: 0,
      attempts: 5,
      funded: 2,
      failed: 1,
      refused: 2,
      pending: 1,
      fundedUsdc: 1.75,
      refusalsByReason: { agent_origin: 1, over_cap: 1 },
      agentOriginRefusals: 1,
    });
    expect(ledger.paymentSummary(2500)).toMatchObject({ attempts: 3, funded: 0 });
    expect(ledger.fundedUsdcSince(0)).toBe(1.75);
    expect(ledger.fundedUsdcSince(1500)).toBe(0.5);
    expect(ledger.fundedTxFor("a")).toBe("0x1");
    expect(ledger.fundedTxFor("e")).toBeNull();
    expect(ledger.latestPaymentFor("f")).toMatchObject({ outcome: "pending", ts: 6000 });
    expect(ledger.latestPaymentFor("a")).toMatchObject({ outcome: "pending", ts: 900 });
    expect(ledger.latestPaymentFor("zz")).toBeNull();
    expect(ledger.recentPayments(2).map((r) => r.jobId)).toEqual(["f", "a"]);
  });

  it("shares the database with the embedding ledger and the delivery tables", () => {
    store = ComputeDeliveryStore.inMemory();
    store.recordOrigin("j", "agent", "agent:main:main", 1);
    store.ledger().recordPayment({
      ts: 1,
      jobId: "j",
      quoteHash: null,
      amountUsdc: 1,
      payee: null,
      outcome: "funded",
      reason: null,
      reviewId: null,
      decidedBy: null,
      via: null,
      txHash: "0x",
    });
    expect(store.originOf("j")?.origin).toBe("agent");
    expect(store.ledger().fundedTxFor("j")).toBe("0x");
  });
});
