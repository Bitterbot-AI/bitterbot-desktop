import { describe, expect, it, vi } from "vitest";

/**
 * The review stage is the first thing a hooked tool call meets. This drives the
 * real hook wrapper with the review runtime faked, to pin where the stage sits
 * and what the model sees.
 */

const svc = vi.hoisted(() => ({ consider: vi.fn() }));

vi.mock("../review/runtime.js", () => ({
  getReviewService: () => ({ consider: svc.consider }),
  resolveReviewPolicy: () => ({ spend: "ask", publish: "ask", ttlMs: 1000 }),
}));

import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./tools/common.js";

const wallet = (execute: () => Promise<unknown>) =>
  wrapToolWithBeforeToolCallHook(
    {
      name: "wallet",
      label: "Wallet",
      description: "",
      parameters: {},
      execute,
    } as unknown as AnyAgentTool,
    { sessionKey: "agent:main:main", agentId: "main" },
  );

describe("tool-call hook: review stage", () => {
  it("holds a spend before the tool runs and surfaces the hold to the model", async () => {
    svc.consider.mockResolvedValue({
      kind: "hold",
      created: true,
      action: { id: "rv-00000001", preview: "Send 5 USDC to 0xabc" },
    });
    const execute = vi.fn(async () => ({ content: [] }));

    await expect(
      wallet(execute).execute?.(
        "call-1",
        { action: "send_usdc", address: "0xabc", amount: 5 },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/APPROVAL-REQUIRED \(rv-00000001\)/);

    expect(execute).not.toHaveBeenCalled();
  });

  it("runs the tool when the review passes", async () => {
    svc.consider.mockResolvedValue({ kind: "pass", reason: "allowed" });
    const execute = vi.fn(async () => ({ content: [{ type: "text", text: "sent" }] }));

    await wallet(execute).execute?.(
      "call-2",
      { action: "send_usdc", address: "0xabc", amount: 5 },
      undefined,
      undefined,
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not involve the review for a wallet read", async () => {
    svc.consider.mockReset();
    const execute = vi.fn(async () => ({ content: [] }));

    await wallet(execute).execute?.("call-3", { action: "get_balance" }, undefined, undefined);

    expect(svc.consider).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
