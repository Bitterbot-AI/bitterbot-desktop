import { describe, expect, it } from "vitest";
import { classifyToolCall } from "./classify.js";

describe("classifyToolCall", () => {
  it("classifies a USDC send as spend with payee and amount", () => {
    expect(
      classifyToolCall("wallet", { action: "send_usdc", address: "0xabc", amount: 5 }),
    ).toEqual({ cls: "spend", preview: "Send 5 USDC to 0xabc", payee: "0xabc", amountUsd: 5 });
  });

  it("classifies a peer payment and an x402 payment as spend", () => {
    expect(
      classifyToolCall("wallet", { action: "send_to_peer", peer_id: "12D3Koo", amount: 0.5 }),
    ).toMatchObject({
      cls: "spend",
      payee: "12D3Koo",
      amountUsd: 0.5,
    });
    expect(
      classifyToolCall("wallet", {
        action: "pay_for_resource",
        resource_url: "https://api.example.com/report",
        amount: 0.25,
        reason: "quarterly data",
      }),
    ).toMatchObject({
      cls: "spend",
      preview: "Pay 0.25 USDC for https://api.example.com/report (quarterly data)",
      payee: "https://api.example.com/report",
    });
  });

  it("does not review wallet reads", () => {
    for (const action of ["get_balance", "get_address", "get_transaction_history", "fund_wallet"]) {
      expect(classifyToolCall("wallet", { action })).toBeNull();
    }
  });

  it("says when the amount is missing instead of inventing one", () => {
    expect(classifyToolCall("wallet", { action: "send_usdc", address: "0xabc" })).toMatchObject({
      preview: "Send an unspecified amount to 0xabc",
      amountUsd: undefined,
    });
    expect(
      classifyToolCall("wallet", { action: "send_usdc", address: "0xabc", amount: -1 })?.amountUsd,
    ).toBeUndefined();
  });

  it("classifies a post to X as publish", () => {
    expect(classifyToolCall("message", { channel: "x", message: "Shipping today" })).toEqual({
      cls: "publish",
      preview: 'Post to X: "Shipping today"',
    });
    expect(classifyToolCall("message", { channel: "X", action: "send", message: "hi" })?.cls).toBe(
      "publish",
    );
  });

  it("does not review ordinary messages or X actions other than posting", () => {
    expect(
      classifyToolCall("message", { channel: "telegram", to: "123", message: "hi" }),
    ).toBeNull();
    expect(
      classifyToolCall("message", { channel: "x", action: "delete", messageId: "1" }),
    ).toBeNull();
    expect(classifyToolCall("exec", { command: "ls" })).toBeNull();
    expect(classifyToolCall("wallet", "send_usdc")).toBeNull();
  });

  it("keeps previews bounded", () => {
    const long = classifyToolCall("message", { channel: "x", message: "x".repeat(5000) });

    expect(long?.preview.length).toBeLessThan(260);
  });

  it("names the required parameters a spend call left out", () => {
    // Seen live: the model passed `to` where the wallet tool takes `address`.
    expect(
      classifyToolCall("wallet", { action: "send_usdc", to: "0xabc", amount: 0.01 })?.missing,
    ).toEqual(["address"]);
    expect(classifyToolCall("wallet", { action: "send_to_peer" })?.missing).toEqual([
      "peer_id",
      "amount",
    ]);
    expect(
      classifyToolCall("wallet", { action: "send_usdc", address: "0xabc", amount: 1 })?.missing,
    ).toBeUndefined();
  });
});
