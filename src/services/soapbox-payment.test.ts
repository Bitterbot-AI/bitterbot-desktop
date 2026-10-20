import { describe, expect, it } from "vitest";
import { SOAPBOX_PAYMENT_POLICY } from "../infra/soapbox-payment-policy.js";
import {
  assertApprovedSoapboxQuote,
  validateSoapboxQuote,
  type SoapboxPaymentQuote,
} from "./soapbox-payment.js";

const buyer = `0x${"1".repeat(40)}`;
const quote = (): SoapboxPaymentQuote => ({
  chain_id: 84532,
  token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  escrow: `0x${"2".repeat(40)}`,
  buyer,
  operator: `0x${"3".repeat(40)}`,
  key: `0x${"a".repeat(64)}`,
  amount_microusdc: 33000,
  expires: Math.floor(Date.now() / 1000) + 3600,
});
describe("Soapbox wallet funding boundary", () => {
  it("ships a valid Base Sepolia deployment pin without mocking release policy", () => {
    expect(SOAPBOX_PAYMENT_POLICY.chainId).toBe(84532);
    expect(SOAPBOX_PAYMENT_POLICY.escrow).toMatch(/^0x[\da-f]{40}$/);
    expect(SOAPBOX_PAYMENT_POLICY.codeSha256).toMatch(/^[\da-f]{64}$/);
    expect(Buffer.from(SOAPBOX_PAYMENT_POLICY.codeSha256, "hex").toString("hex")).toBe(
      SOAPBOX_PAYMENT_POLICY.codeSha256,
    );
  });
  it("requires approval of every payment field and rejects changed quotes", () => {
    const payment = quote();
    expect(() => assertApprovedSoapboxQuote(undefined, payment)).toThrow("approve");
    expect(() => assertApprovedSoapboxQuote({ ...payment }, payment)).not.toThrow();
    for (const field of [
      "chain_id",
      "token",
      "escrow",
      "key",
      "buyer",
      "operator",
      "amount_microusdc",
      "expires",
    ])
      expect(() => assertApprovedSoapboxQuote({ ...payment, [field]: "changed" }, payment)).toThrow(
        "changed",
      );
  });
  it("allows exact integer test-USDC quotes for the current buyer", () => {
    expect(() => validateSoapboxQuote(quote(), buyer, "base-sepolia")).not.toThrow();
  });
  it("blocks mainnet, another buyer, another token, and excessive or fractional amounts", () => {
    expect(() => validateSoapboxQuote(quote(), buyer, "base")).toThrow(/Sepolia/);
    for (const change of [
      { chain_id: 8453 },
      { buyer: `0x${"4".repeat(40)}` },
      { token: `0x${"5".repeat(40)}` },
      { amount_microusdc: 100_000_001 },
      { amount_microusdc: 0.5 },
      { amount_microusdc: Number.NaN },
      { expires: 1 },
      { escrow: "0x0000000000000000000000000000000000000000" },
    ])
      expect(() =>
        validateSoapboxQuote({ ...quote(), ...change }, buyer, "base-sepolia"),
      ).toThrow();
  });
});
