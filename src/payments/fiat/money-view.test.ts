/**
 * PLAN-49 Phase 1: the dollar-denominated money view. Asserts the dollar basis
 * (1 USDC = $1, I5), plain-English categorization, and that a fee is never hidden
 * (I5 no-hidden-fee).
 */
import { describe, expect, it } from "vitest";
import { buildMoneyView, kindForTxType, usdcToUsd, type MoneyEvent } from "./money-view.js";

describe("money-view — dollar abstraction (PLAN-49 Phase 1)", () => {
  it("shows the USDC balance as dollars 1:1 (I5)", () => {
    expect(usdcToUsd("12.5")).toBe(12.5);
    const v = buildMoneyView({ balanceUsdc: "12.5", events: [] });
    expect(v.balanceUsd).toBe(12.5);
    expect(v.currency).toBe("USD");
  });

  it("categorizes wallet tx types into money-event kinds", () => {
    expect(kindForTxType("send")).toBe("spent");
    expect(kindForTxType("x402_payment")).toBe("spent");
    expect(kindForTxType("receive")).toBe("funded");
    expect(kindForTxType("sale")).toBe("earned");
    expect(kindForTxType("offramp")).toBe("withdrawn");
    expect(kindForTxType("mystery")).toBe("spent"); // unknown debit = conservative
  });

  it("renders plain-English descriptions and signed deltas", () => {
    const events: MoneyEvent[] = [
      { kind: "spent", amountUsd: 0.4, at: 2, counterparty: "a peer agent" },
      { kind: "funded", amountUsd: 20, at: 3, counterparty: "Coinbase" },
      { kind: "earned", amountUsd: 1.5, at: 1, counterparty: "a buyer" },
      { kind: "withdrawn", amountUsd: 10, at: 4 },
    ];
    const v = buildMoneyView({ balanceUsdc: 11.1, events });
    // Newest-first ordering.
    expect(v.entries.map((e) => e.at)).toEqual([4, 3, 2, 1]);
    const byKind = Object.fromEntries(v.entries.map((e) => [e.kind, e]));
    expect(byKind.funded!.description).toBe("Added funds via Coinbase");
    expect(byKind.spent!.description).toBe("Paid a peer agent");
    expect(byKind.earned!.description).toBe("Earned from a buyer");
    expect(byKind.withdrawn!.description).toBe("Withdrew to bank");
    // Signed deltas: inflows +, outflows -.
    expect(byKind.funded!.deltaUsd).toBe(20);
    expect(byKind.earned!.deltaUsd).toBe(1.5);
    expect(byKind.spent!.deltaUsd).toBe(-0.4);
    expect(byKind.withdrawn!.deltaUsd).toBe(-10);
  });

  it("surfaces fees rather than folding them into the amount (I5 no-hidden-fee)", () => {
    const v = buildMoneyView({
      balanceUsdc: 100,
      events: [
        { kind: "funded", amountUsd: 100, feeUsd: 2.5, at: 1, counterparty: "Coinbase" }, // pay $100, $2.50 fee
        { kind: "spent", amountUsd: 0.5, feeUsd: 0.01, at: 2, counterparty: "a peer" },
      ],
    });
    // The fee is visible in totals and in the entry, never merged into amountUsd.
    expect(v.totals.feesUsd).toBe(2.51);
    const funded = v.entries.find((e) => e.kind === "funded")!;
    expect(funded.amountUsd).toBe(100); // amount untouched
    expect(funded.feeUsd).toBe(2.5); // fee explicit
    expect(funded.deltaUsd).toBe(97.5); // what actually landed = amount - fee
    const spent = v.entries.find((e) => e.kind === "spent")!;
    expect(spent.deltaUsd).toBe(-0.51); // cost = amount + fee
  });

  it("sums totals per kind", () => {
    const v = buildMoneyView({
      balanceUsdc: 0,
      events: [
        { kind: "spent", amountUsd: 0.4, at: 1 },
        { kind: "spent", amountUsd: 0.6, at: 2 },
        { kind: "earned", amountUsd: 2, at: 3 },
        { kind: "funded", amountUsd: 20, at: 4 },
        { kind: "withdrawn", amountUsd: 5, at: 5 },
      ],
    });
    expect(v.totals.spentUsd).toBe(1);
    expect(v.totals.earnedUsd).toBe(2);
    expect(v.totals.fundedUsd).toBe(20);
    expect(v.totals.withdrawnUsd).toBe(5);
  });

  it("ignores non-positive or non-finite amounts safely", () => {
    const v = buildMoneyView({
      balanceUsdc: "not-a-number",
      events: [
        { kind: "spent", amountUsd: -1, at: 1 },
        { kind: "funded", amountUsd: Number.NaN, at: 2 },
      ],
    });
    expect(v.balanceUsd).toBe(0);
    expect(v.totals.spentUsd).toBe(0);
    expect(v.totals.fundedUsd).toBe(0);
  });
});
