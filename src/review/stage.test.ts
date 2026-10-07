import { describe, expect, it, vi } from "vitest";

/**
 * The stage sits first in the tool-call hook. It must be invisible to tools
 * it does not classify, and fail closed for the ones it does.
 */

const svc = vi.hoisted(() => ({
  consider: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getReviewService: () => ({ consider: svc.consider }),
  resolveReviewPolicy: () => ({ spend: "ask", publish: "ask", ttlMs: 1000 }),
}));

import { runReviewStage } from "./stage.js";

describe("runReviewStage", () => {
  it("never consults the service for an unclassified tool", async () => {
    svc.consider.mockReset();

    expect(await runReviewStage({ toolName: "exec", params: { command: "ls" } })).toEqual({
      blocked: false,
    });
    expect(await runReviewStage({ toolName: "wallet", params: { action: "get_balance" } })).toEqual(
      { blocked: false },
    );
    expect(svc.consider).not.toHaveBeenCalled();
  });

  it("blocks a held spend with the message the agent should read", async () => {
    svc.consider.mockResolvedValue({
      kind: "hold",
      created: true,
      action: { id: "rv-00000001", preview: "Send 5 USDC to 0xabc" },
    });

    const out = await runReviewStage({
      toolName: "wallet",
      params: { action: "send_usdc", address: "0xabc", amount: 5 },
      ctx: { sessionKey: "agent:main:main" },
    });

    expect(out.blocked).toBe(true);
    expect(out.blocked && out.reason).toContain("APPROVAL-REQUIRED (rv-00000001)");
    expect(svc.consider).toHaveBeenCalledWith(
      "wallet",
      { action: "send_usdc", address: "0xabc", amount: 5 },
      { sessionKey: "agent:main:main" },
      { spend: "ask", publish: "ask", ttlMs: 1000 },
    );
  });

  it("lets a pass through", async () => {
    svc.consider.mockResolvedValue({ kind: "pass", reason: "grant" });

    expect(
      await runReviewStage({
        toolName: "wallet",
        params: { action: "send_usdc", address: "0xabc", amount: 5 },
      }),
    ).toEqual({ blocked: false });
  });

  it("fails closed when the review service itself breaks", async () => {
    // A spend with no working review is not allowed to go ahead quietly.
    svc.consider.mockRejectedValue(new Error("review.sqlite is read-only"));

    const out = await runReviewStage({
      toolName: "wallet",
      params: { action: "send_usdc", address: "0xabc", amount: 5 },
    });

    expect(out.blocked).toBe(true);
    expect(out.blocked && out.reason).toContain("review service failed");
    expect(out.blocked && out.reason).toContain("not performed");
  });

  it("sends a malformed spend back to the agent without queuing it", async () => {
    svc.consider.mockReset();

    const outcome = await runReviewStage({
      toolName: "wallet",
      params: { action: "send_usdc", to: "0xabc", amount: 0.01 },
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.blocked && outcome.reason).toContain("missing required parameter(s): address");
    expect(svc.consider).not.toHaveBeenCalled();
  });

  it("sends a message to a Circles friend via webchat back to the agent, pointing at the circles tool", async () => {
    svc.consider.mockReset();

    const outcome = await runReviewStage({
      toolName: "message",
      params: { action: "send", to: "sylvia", message: "the count is ~116K", channel: "webchat" },
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.blocked && outcome.reason).toContain("circles tool (action=send)");
    expect(svc.consider).not.toHaveBeenCalled();
  });
});
