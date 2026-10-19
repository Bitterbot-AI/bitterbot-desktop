import { describe, expect, it } from "vitest";
import { type ComputeQuoteView, describeQuote } from "./compute-cli.js";

const view = (over: Partial<ComputeQuoteView> = {}): ComputeQuoteView => ({
  jobId: "j-42",
  quote: {
    amountUsdc: 0.42,
    payee: "0xabc",
    network: "base-sepolia",
    expiresAt: null,
    quoteHash: "q",
  },
  pendingReview: null,
  fundedTx: null,
  paid: { enabled: true, maxUsdcPerJob: 5, maxUsdcPerDay: 20 },
  ...over,
});

describe("bitterbot compute: describeQuote", () => {
  it("states the amount and payee, and names the agent's pending hold", () => {
    const lines = describeQuote(view({ pendingReview: "rv-1" }));
    expect(lines[0]).toBe("Job j-42 is waiting for payment.");
    expect(lines).toContain("  Amount: 0.42 USDC");
    expect(lines).toContain("  Payee: 0xabc (base-sepolia)");
    expect(lines.some((l) => l.includes("rv-1"))).toBe(true);
  });

  it("says when nothing is waiting, when it is already funded, and when approving would be refused", () => {
    expect(describeQuote(view({ quote: null }))).toEqual(["Job j-42 is not waiting for payment."]);
    expect(describeQuote(view({ fundedTx: "0x1" }))[0]).toContain("already funded");
    expect(
      describeQuote(view({ paid: { enabled: false, maxUsdcPerJob: 5, maxUsdcPerDay: 20 } })).at(-1),
    ).toContain("Paid compute is off");
    expect(
      describeQuote(view({ paid: { enabled: true, maxUsdcPerJob: 0.1, maxUsdcPerDay: 20 } })).at(
        -1,
      ),
    ).toContain("per-job cap");
  });
});
