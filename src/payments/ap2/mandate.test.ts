import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AP2_VCT,
  MandateConstraintError,
  issueIntentMandate,
  issuePaymentMandate,
  mandateHash,
  usdc,
  verifyMandate,
  verifyPaymentAgainstIntent,
  type RecoverFn,
} from "./mandate.js";

// Fixture signer/recover: a signature is `valid:<addr>:<sha256(canonical)>`. The
// recover fn returns <addr> only if the embedded hash matches the canonical it
// is asked to verify, so tampering with signed claims fails recovery (mirrors
// x402-verify.test.ts's "valid:<addr>" fixture, extended to bind the payload).
function makeSigner(addr: string) {
  return async (canonical: string): Promise<string> =>
    `valid:${addr.toLowerCase()}:${createHash("sha256").update(canonical).digest("hex")}`;
}
const recover: RecoverFn = async (canonical, signature) => {
  const m = /^valid:(0x[a-fA-F0-9]{40}):([0-9a-f]{64})$/.exec(signature);
  if (!m) throw new Error("malformed signature");
  const expected = createHash("sha256").update(canonical).digest("hex");
  if (m[2] !== expected) throw new Error("signature does not cover these claims");
  return m[1];
};

const AGENT = "0x1593000000000000000000000000000000000000";
const MERCHANT = "0x00000000000000000000000000000000000000aa";

async function standingIntent(maxUsd = 1, opts?: { payees?: string[]; ttlMs?: number }) {
  return issueIntentMandate({
    agentAddress: AGENT,
    maxAmount: usdc(maxUsd),
    totalAmount: usdc(50),
    allowedPayees: opts?.payees,
    promptPlayback: "pay for the peer task the user asked me to run",
    ttlMs: opts?.ttlMs ?? 3_600_000,
    sign: makeSigner(AGENT),
  });
}

describe("AP2 mandate layer (PLAN-47 Phase 1)", () => {
  it("issues and self-verifies an Intent mandate", async () => {
    const intent = await standingIntent();
    expect(intent.claims.vct).toBe(AP2_VCT.intent);
    const r = await verifyMandate(intent, { recover });
    expect(r.valid).toBe(true);
  });

  // I1 (happy path): a payment within the intent's ceiling verifies against it.
  it("I1 — a Payment mandate within limits verifies against its Intent", async () => {
    const intent = await standingIntent(1);
    const payment = await issuePaymentMandate({
      intent,
      agentAddress: AGENT,
      payee: { id: MERCHANT, name: "peer" },
      amount: usdc(0.25),
      instrument: { id: AGENT, type: "x402-usdc", description: "USDC on Base via x402" },
      transactionId: "0xdeadbeef",
      ttlMs: 300_000,
      sign: makeSigner(AGENT),
    });
    expect(payment.claims.vct).toBe(AP2_VCT.payment);
    expect(payment.claims.intent_ref).toBe(mandateHash(intent));
    const r = await verifyPaymentAgainstIntent({ payment, intent, recover });
    expect(r.valid).toBe(true);
  });

  // I1 (core): the emitter refuses to sign an over-authorization.
  it("I1 — refuses to emit a Payment above the Intent's max_amount", async () => {
    const intent = await standingIntent(1);
    await expect(
      issuePaymentMandate({
        intent,
        agentAddress: AGENT,
        payee: { id: MERCHANT },
        amount: usdc(5),
        instrument: { id: AGENT, type: "x402-usdc" },
        transactionId: "0x1",
        ttlMs: 300_000,
        sign: makeSigner(AGENT),
      }),
    ).rejects.toBeInstanceOf(MandateConstraintError);
  });

  it("I1 — refuses to emit a Payment to a payee outside the Intent allow-list", async () => {
    const intent = await standingIntent(1, {
      payees: ["0x00000000000000000000000000000000000000bb"],
    });
    await expect(
      issuePaymentMandate({
        intent,
        agentAddress: AGENT,
        payee: { id: MERCHANT },
        amount: usdc(0.5),
        instrument: { id: AGENT, type: "x402-usdc" },
        transactionId: "0x2",
        ttlMs: 300_000,
        sign: makeSigner(AGENT),
      }),
    ).rejects.toBeInstanceOf(MandateConstraintError);
  });

  it("rejects an expired mandate", async () => {
    const intent = await standingIntent(1, { ttlMs: 1000 });
    const r = await verifyMandate(intent, { recover, now: intent.claims.exp + 1 });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/expired/);
  });

  it("rejects a mandate whose claims were tampered with after signing", async () => {
    const intent = await standingIntent(1);
    // Mutate a claim; the fixture recover binds the signature to the canonical
    // claims, so the recovered signer no longer matches -> invalid.
    const tampered = {
      ...intent,
      claims: {
        ...intent.claims,
        constraints: { ...intent.claims.constraints, max_amount: usdc(999) },
      },
    };
    const r = await verifyMandate(tampered, { recover });
    expect(r.valid).toBe(false);
  });

  it("rejects a Payment presented against a different Intent (intent_ref mismatch)", async () => {
    const intentA = await standingIntent(1);
    // Distinct delegation (different prompt_playback) => distinct hash.
    const intentB = await issueIntentMandate({
      agentAddress: AGENT,
      maxAmount: usdc(1),
      promptPlayback: "a different delegation entirely",
      ttlMs: 3_600_000,
      sign: makeSigner(AGENT),
    });
    const payment = await issuePaymentMandate({
      intent: intentA,
      agentAddress: AGENT,
      payee: { id: MERCHANT },
      amount: usdc(0.5),
      instrument: { id: AGENT, type: "x402-usdc" },
      transactionId: "0x3",
      ttlMs: 300_000,
      sign: makeSigner(AGENT),
    });
    const r = await verifyPaymentAgainstIntent({ payment, intent: intentB, recover });
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/intent_ref/);
  });
});
