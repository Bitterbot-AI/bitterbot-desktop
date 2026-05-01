import { describe, expect, it } from "vitest";
import { canonicalizePaymentPayload } from "./a2a-client.js";

describe("canonicalizePaymentPayload", () => {
  it("produces a stable, lowercased canonical string", () => {
    const out = canonicalizePaymentPayload({
      txHash: "0xABC",
      amount: 0.05,
      sender: "0xSender",
      recipient: "0xRecipient",
      timestamp: 1700000000000,
      version: "v1",
    });
    expect(out).toBe("bitterbot-x402:v1:0xrecipient:0xabc:0.05:0xsender:1700000000000");
  });

  it("differs when any field changes (recipient binding)", () => {
    const a = canonicalizePaymentPayload({
      txHash: "0xabc",
      amount: 0.1,
      sender: "0xs",
      recipient: "0xa",
      timestamp: 1,
      version: "v1",
    });
    const b = canonicalizePaymentPayload({
      txHash: "0xabc",
      amount: 0.1,
      sender: "0xs",
      recipient: "0xb",
      timestamp: 1,
      version: "v1",
    });
    expect(a).not.toBe(b);
  });

  it("differs when amount changes", () => {
    const a = canonicalizePaymentPayload({
      txHash: "0xa",
      amount: 0.1,
      sender: "0xs",
      recipient: "0xr",
      timestamp: 1,
      version: "v1",
    });
    const b = canonicalizePaymentPayload({
      txHash: "0xa",
      amount: 0.11,
      sender: "0xs",
      recipient: "0xr",
      timestamp: 1,
      version: "v1",
    });
    expect(a).not.toBe(b);
  });

  it("includes the bitterbot-x402:v1 prefix so v2 tokens won't validate against v1 verifiers", () => {
    const out = canonicalizePaymentPayload({
      txHash: "0xa",
      amount: 0.1,
      sender: "0xs",
      recipient: "0xr",
      timestamp: 1,
      version: "v1",
    });
    expect(out.startsWith("bitterbot-x402:v1:")).toBe(true);
  });
});
