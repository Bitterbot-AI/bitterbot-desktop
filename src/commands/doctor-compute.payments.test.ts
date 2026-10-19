import { describe, expect, it } from "vitest";
import { ComputeDeliveryStore } from "../compute/awareness/deliveries.js";
import type { BitterbotConfig } from "../config/config.js";
import { collectComputePaymentResults, summarisePayments } from "./doctor-compute.js";

const paidOn = { compute: { paid: { enabled: true } } } as BitterbotConfig;

describe("doctor: compute payments (PLAN-57 §4.8)", () => {
  it("is quiet when nothing was attempted, and says whether the paid path is on", () => {
    expect(
      summarisePayments(
        {
          since: 0,
          attempts: 0,
          funded: 0,
          failed: 0,
          refused: 0,
          pending: 0,
          fundedUsdc: 0,
          refusalsByReason: {},
          agentOriginRefusals: 0,
        },
        false,
      ),
    ).toEqual([
      expect.objectContaining({
        level: "info",
        message: expect.stringContaining("Paid compute is off"),
      }),
    ]);
    expect(
      summarisePayments(
        {
          since: 0,
          attempts: 0,
          funded: 0,
          failed: 0,
          refused: 0,
          pending: 0,
          fundedUsdc: 0,
          refusalsByReason: {},
          agentOriginRefusals: 0,
        },
        true,
      )[0]?.message,
    ).toContain("Paid compute is on");
  });

  it("makes an agent-origin refusal an error and other refusals and failures warnings", () => {
    const results = summarisePayments(
      {
        since: 0,
        attempts: 4,
        funded: 1,
        failed: 1,
        refused: 2,
        pending: 1,
        fundedUsdc: 0.75,
        refusalsByReason: { agent_origin: 1, over_cap: 1 },
        agentOriginRefusals: 1,
      },
      true,
    );
    expect(results.map((r) => r.level)).toEqual(["ok", "error", "warn", "warn", "warn"]);
    expect(results[0]?.message).toContain("1 job(s) funded, 0.75 USDC");
    expect(results[1]?.message).toContain("agent-origin");
    expect(results[2]?.message).toContain("over_cap 1");
    expect(results[3]?.message).toContain("failed at the coordinator");
    expect(results[4]?.message).toContain("never settled");
  });

  it("reads the ledger from the store", () => {
    const store = ComputeDeliveryStore.inMemory();
    try {
      store.ledger().recordPayment({
        ts: 10,
        jobId: "j",
        quoteHash: "q",
        amountUsdc: 0.2,
        payee: "0x",
        outcome: "funded",
        reason: null,
        reviewId: null,
        decidedBy: "v",
        via: "cli",
        txHash: "0x1",
      });
      // In-memory stores are per connection; the doctor opens its own, so feed it the summary path instead.
      expect(summarisePayments(store.ledger().paymentSummary(0), true)[0]?.level).toBe("ok");
    } finally {
      store.close();
    }
    expect(
      collectComputePaymentResults({ compute: { enabled: false } } as BitterbotConfig),
    ).toEqual([expect.objectContaining({ level: "info" })]);
    expect(
      collectComputePaymentResults(paidOn, { dbPath: "/nonexistent/compute.sqlite" })[0]?.message,
    ).toContain("no funding has been attempted yet");
  });
});
