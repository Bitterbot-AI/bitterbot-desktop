import { describe, expect, it } from "vitest";
import { describeWalletResult, summarizeToolResult } from "./executors.js";

describe("summarizeToolResult", () => {
  it("keeps the tool's text and notices a reported error", () => {
    expect(summarizeToolResult({ content: [{ type: "text", text: "posted" }] })).toEqual({
      ok: true,
      summary: "posted",
    });
    expect(
      summarizeToolResult({ content: [], details: { status: "error", error: "no funds" } }),
    ).toEqual({ ok: false, summary: "no funds" });
  });
});

describe("describeWalletResult", () => {
  it("says a send in a sentence", () => {
    // The shape the wallet returned on the first live approval (2026-10-04).
    const summary = JSON.stringify({
      txHash: "0x30ee",
      status: "pending",
      amount: 0.01,
      to: "0x1593",
      sessionSpent: 0.01,
      sessionRemaining: 49.99,
    });

    expect(describeWalletResult({ ok: true, summary })).toEqual({
      ok: true,
      summary: "Sent 0.01 USDC to 0x1593. Transaction 0x30ee (pending).",
    });
  });

  it("leaves failures and anything that is not a send as they came", () => {
    const failed = { ok: false, summary: '{"txHash":"0x1"}' };
    expect(describeWalletResult(failed)).toBe(failed);
    const plain = { ok: true, summary: "Balance: 4 USDC" };
    expect(describeWalletResult(plain)).toBe(plain);
    const other = { ok: true, summary: '{"paid":true}' };
    expect(describeWalletResult(other)).toBe(other);
  });
});
