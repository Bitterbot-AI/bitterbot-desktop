import { describe, expect, it } from "vitest";
import { describeSpend, type SpendDecision } from "./ActivityPanel";

const d = (overrides: Partial<SpendDecision>): SpendDecision => ({
  id: "sd-1",
  ts: 1,
  origin: "wallet-tool",
  payee: "0xbob",
  amountUsd: 5,
  verdict: "allow",
  reason: "passed review",
  outcome: "sent",
  ...overrides,
});

describe("describeSpend", () => {
  it("says what was sent and on what authority", () => {
    expect(describeSpend(d({})).text).toBe("Sent $5.00 to 0xbob (passed review)");
  });

  it("says why a payment was refused", () => {
    expect(
      describeSpend(d({ verdict: "deny", outcome: "refused", reason: "session cap" })),
    ).toEqual({
      tone: "text-warning",
      text: "Refused $5.00 to 0xbob: session cap",
    });
  });

  it("says a payment failed, with the error", () => {
    expect(describeSpend(d({ outcome: "failed", error: "nonce too low" })).text).toBe(
      "Failed to send $5.00 to 0xbob: nonce too low",
    );
  });
});
