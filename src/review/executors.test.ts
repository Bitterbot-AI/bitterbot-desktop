import { describe, expect, it, vi } from "vitest";
import type { ReviewAction } from "./store.js";

const approveComputeFunding = vi.fn();
vi.mock("../compute/awareness/payment.js", () => ({
  approveComputeFunding: (p: unknown) => approveComputeFunding(p),
}));

import { createDefaultExecutors, describeWalletResult, summarizeToolResult } from "./executors.js";

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

describe("compute executor (PLAN-57 §4.8)", () => {
  const action = {
    id: "rv-9",
    tool: "compute",
    cls: "spend",
    params: { action: "fund", job_id: "j1", quote_hash: "qh" },
    sessionKey: "agent:main:main",
  } as unknown as ReviewAction;

  it("funds with the resolving connection's authority bound to the hold's job and quote", async () => {
    approveComputeFunding.mockResolvedValueOnce({
      ok: true,
      jobId: "j1",
      amountUsdc: 0.5,
      payee: "0xop",
      quoteHash: "qh",
      txHash: "0xabc",
      status: "pending",
    });
    const run = createDefaultExecutors(() => ({})).get("compute")!;
    const out = await run(action, {
      decidedBy: "victor",
      decidedVia: "control-ui",
      scopes: ["operator.approvals"],
    });
    expect(out).toEqual({
      ok: true,
      summary: "Funded compute job j1: 0.5 USDC to 0xop. Transaction 0xabc (pending).",
    });
    expect(approveComputeFunding).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "j1",
        expectedQuoteHash: "qh",
        authority: {
          origin: "owner",
          scopes: ["operator.approvals"],
          via: "control-ui",
          connectionMode: null,
          decidedBy: "victor",
          reviewId: "rv-9",
        },
      }),
    );
  });

  it("passes the signer's refusal back as the outcome", async () => {
    approveComputeFunding.mockResolvedValueOnce({
      ok: false,
      jobId: "j1",
      reason: "chat_decision",
      message: "A chat reply is not an authenticated owner session for payments.",
    });
    const run = createDefaultExecutors(() => ({})).get("compute")!;
    const out = await run(action, { decidedBy: "victor", decidedVia: "chat" });
    expect(out.ok).toBe(false);
    expect(out.summary).toContain("chat reply");
    expect(approveComputeFunding).toHaveBeenLastCalledWith(
      expect.objectContaining({ authority: expect.objectContaining({ via: "chat", scopes: [] }) }),
    );
  });

  it("refuses a hold that names no job without calling the signer", async () => {
    approveComputeFunding.mockClear();
    const run = createDefaultExecutors(() => ({})).get("compute")!;
    const out = await run({ ...action, params: {} } as ReviewAction, {
      decidedBy: "v",
      decidedVia: "cli",
    });
    expect(out.ok).toBe(false);
    expect(approveComputeFunding).not.toHaveBeenCalled();
  });
});
