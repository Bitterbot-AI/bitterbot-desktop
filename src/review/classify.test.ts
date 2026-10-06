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

  it("does not review replies in the current conversation or X actions other than posting", () => {
    // No recipient named: the message goes where the agent already is.
    expect(classifyToolCall("message", { channel: "telegram", message: "hi" })).toBeNull();
    expect(classifyToolCall("message", { action: "send", message: "hi" })).toBeNull();
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

  it("classifies a message to a named recipient as contact", () => {
    expect(
      classifyToolCall("message", { channel: "Telegram", to: "123", message: "hi there" }),
    ).toEqual({
      cls: "contact",
      preview: 'Message telegram 123: "hi there"',
      recipients: [{ channel: "telegram", target: "123" }],
    });
    // The channel may be left to the run.
    expect(
      classifyToolCall("message", {
        action: "sendAttachment",
        target: "+15550100",
        caption: "the file",
      }),
    ).toMatchObject({
      cls: "contact",
      preview: 'Message +15550100: "the file"',
      recipients: [{ target: "+15550100" }],
    });
  });

  it("names every recipient of a broadcast", () => {
    const c = classifyToolCall("message", {
      action: "broadcast",
      channel: "all",
      targets: ["+15550100", "+15550101", "+15550102", "+15550103"],
      message: "hello all",
    });

    expect(c?.cls).toBe("contact");
    expect(c?.recipients).toHaveLength(4);
    expect(c?.preview).toBe(
      'Message 4 recipients (+15550100, +15550101, +15550102, ...): "hello all"',
    );
  });

  it("does not treat reads, reactions or dry runs as contact", () => {
    expect(
      classifyToolCall("message", { action: "react", channel: "discord", target: "1", emoji: "x" }),
    ).toBeNull();
    expect(
      classifyToolCall("message", { action: "read", channel: "slack", target: "C1" }),
    ).toBeNull();
    expect(
      classifyToolCall("message", {
        channel: "telegram",
        target: "123",
        message: "hi",
        dryRun: true,
      }),
    ).toBeNull();
  });

  it("holds a Privacy.com purchase request as a spend, and leaves Link requests to the Link app", () => {
    expect(
      classifyToolCall("purchase", {
        action: "request",
        rail: "privacy",
        merchant_name: "Shop",
        merchant_url: "https://shop.com",
        amount_usd: 25,
        context: "Running shoes, men's 9",
      }),
    ).toMatchObject({ cls: "spend", payee: "Shop", amountUsd: 25 });
    expect(
      classifyToolCall("purchase", { action: "request", rail: "privacy", merchant_name: "Shop" }),
    ).toMatchObject({ missing: ["merchant_url", "amount_usd"] });
    expect(classifyToolCall("purchase", { action: "request", amount_usd: 25 })).toBeNull();
    expect(
      classifyToolCall("purchase", { action: "fill_card", rail: "privacy", id: "prq_1" }),
    ).toBeNull();
  });
});
