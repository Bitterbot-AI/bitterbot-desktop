import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryEnforcementStore, evaluate, type EnforcementStore } from "./enforcement.js";
import {
  issueIntentMandate,
  issuePaymentMandate,
  usdc,
  type IntentMandateClaims,
  type MandateEnvelope,
  type PaymentMandateClaims,
  type RecoverFn,
} from "./mandate.js";

function makeSigner(addr: string) {
  return async (canonical: string): Promise<string> =>
    `valid:${addr.toLowerCase()}:${createHash("sha256").update(canonical).digest("hex")}`;
}
const recover: RecoverFn = async (canonical, signature) => {
  const m = /^valid:(0x[a-fA-F0-9]{40}):([0-9a-f]{64})$/.exec(signature);
  if (!m) throw new Error("malformed signature");
  if (m[2] !== createHash("sha256").update(canonical).digest("hex")) {
    throw new Error("signature does not cover these claims");
  }
  return m[1];
};

const AGENT = "0x1593000000000000000000000000000000000000";
const SELLER = "0x00000000000000000000000000000000000000aa"; // our receiving address

async function pair(opts?: { payee?: string; amount?: number; max?: number }): Promise<{
  intent: MandateEnvelope<IntentMandateClaims>;
  payment: MandateEnvelope<PaymentMandateClaims>;
}> {
  const intent = await issueIntentMandate({
    agentAddress: AGENT,
    maxAmount: usdc(opts?.max ?? 1),
    ttlMs: 3_600_000,
    sign: makeSigner(AGENT),
  });
  const payment = await issuePaymentMandate({
    intent,
    agentAddress: AGENT,
    payee: { id: opts?.payee ?? SELLER },
    amount: usdc(opts?.amount ?? 0.25),
    instrument: { id: AGENT, type: "x402-usdc" },
    transactionId: "0x" + Math.random().toString(16).slice(2),
    ttlMs: 300_000,
    sign: makeSigner(AGENT),
  });
  return { intent, payment };
}

describe("AP2 enforcement gate (PLAN-47 Phase 4)", () => {
  it("allows a valid, novel, correctly-addressed mandate", async () => {
    const { intent, payment } = await pair();
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(pdr.verdict).toBe("allow");
    expect(pdr.consumed).toBe(true);
  });

  // I2 — consume-once (mandate-scoped): a replay of a valid mandate is denied.
  it("I2 — denies a replayed mandate (consume-once)", async () => {
    const { intent, payment } = await pair();
    const store = new InMemoryEnforcementStore();
    const first = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    const second = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(first.verdict).toBe("allow");
    expect(second.verdict).toBe("deny");
    expect(second.reasons.join()).toMatch(/consume_once/);
  });

  // I3 — context binding: a mandate for merchant X cannot settle against Y.
  it("I3 — denies a mandate whose payee is not the settlement recipient", async () => {
    const OTHER = "0x00000000000000000000000000000000000000bb";
    const { intent, payment } = await pair({ payee: OTHER });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(pdr.verdict).toBe("deny");
    expect(pdr.reasons.join()).toMatch(/context_binding/);
  });

  it("denies when the authorized amount is below what is charged", async () => {
    const { intent, payment } = await pair({ amount: 0.2, max: 1 });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.5,
      recover,
      store,
    });
    expect(pdr.verdict).toBe("deny");
    expect(pdr.reasons.join()).toMatch(/amount/);
  });

  it("denies a mandate with a broken signature chain", async () => {
    const { intent, payment } = await pair();
    const tampered = {
      ...payment,
      claims: { ...payment.claims, payment_amount: usdc(999) }, // mutate after signing
    };
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment: tampered,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(pdr.verdict).toBe("deny");
    expect(pdr.reasons.join()).toMatch(/mandate_invalid/);
  });

  // I6 — a Policy Decision Record is persisted for every decision (allow and deny).
  it("I6 — records a Policy Decision Record for allow and for deny", async () => {
    const store = new InMemoryEnforcementStore();
    const ok = await pair();
    await evaluate({
      payment: ok.payment,
      intent: ok.intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    const bad = await pair({ payee: "0x00000000000000000000000000000000000000bb" });
    await evaluate({
      payment: bad.payment,
      intent: bad.intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(store.decisions).toHaveLength(2);
    expect(store.decisions[0]!.verdict).toBe("allow");
    expect(store.decisions[1]!.verdict).toBe("deny");
    for (const pdr of store.decisions) {
      expect(pdr.mandateId).toMatch(/^sha256:/);
      expect(pdr.agent).toBe(AGENT.toLowerCase());
      expect(typeof pdr.timestamp).toBe("number");
    }
  });

  // Consent lineage (the moat): a valid consent + binding stamps a verified ref.
  it("stamps a verified consentRef when a valid consent lineage is attached", async () => {
    const { buildSpendConsent, buildIdentityBinding } = await import("./consent.js");
    const sha2 = (s: string) => createHash("sha256").update(s).digest("hex");
    const CIRCLE = "ed25519:" + "ab".repeat(32);
    const signCircle = (msg: string) => `${CIRCLE}:${sha2(msg)}`;
    const verifyEd25519 = (msg: string, sig: string, pk: string) => sig === `${pk}:${sha2(msg)}`;
    const { intent, payment } = await pair();
    const consent = buildSpendConsent({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      maxAmount: usdc(1),
      allowedPayees: ["*"],
      ttlMs: 3_600_000,
      signCircle,
    });
    const binding = await buildIdentityBinding({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      signWallet: makeSigner(AGENT),
      signCircle,
    });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
      consent,
      binding,
      verifyEd25519,
    });
    expect(pdr.verdict).toBe("allow");
    expect(pdr.consentRef).toMatch(/^consent:/);
    expect(pdr.reasons.join()).toMatch(/consent_verified/);
  });

  it("records consent_unverified (but does not flip the verdict) on a bad binding", async () => {
    const { buildSpendConsent, buildIdentityBinding } = await import("./consent.js");
    const sha2 = (s: string) => createHash("sha256").update(s).digest("hex");
    const CIRCLE = "ed25519:" + "ab".repeat(32);
    const signCircle = (msg: string) => `${CIRCLE}:${sha2(msg)}`;
    const verifyEd25519 = () => false; // force binding/consent verification to fail
    const { intent, payment } = await pair();
    const consent = buildSpendConsent({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      maxAmount: usdc(1),
      allowedPayees: ["*"],
      ttlMs: 3_600_000,
      signCircle,
    });
    const binding = await buildIdentityBinding({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      signWallet: makeSigner(AGENT),
      signCircle,
    });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
      consent,
      binding,
      verifyEd25519,
    });
    expect(pdr.verdict).toBe("allow"); // consent is additive; does not gate yet
    expect(pdr.reasons.join()).toMatch(/consent_unverified/);
  });

  // --- Consent gating (PLAN-48 Phase 5, D-5) ---
  const sha2 = (s: string) => createHash("sha256").update(s).digest("hex");
  const CIRCLE = "ed25519:" + "cd".repeat(32);
  const signCircle = (msg: string) => `${CIRCLE}:${sha2(msg)}`;
  const verifyOk = (msg: string, sig: string, pk: string) => sig === `${pk}:${sha2(msg)}`;

  async function withConsent() {
    const { buildSpendConsent, buildIdentityBinding } = await import("./consent.js");
    const consent = buildSpendConsent({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      maxAmount: usdc(1),
      allowedPayees: ["*"],
      ttlMs: 3_600_000,
      signCircle,
    });
    const binding = await buildIdentityBinding({
      walletAddress: AGENT,
      circlePubkey: CIRCLE,
      signWallet: makeSigner(AGENT),
      signCircle,
    });
    return { consent, binding };
  }

  it("gates: denies an at/above-threshold spend with no consent, without burning the nonce", async () => {
    const { intent, payment } = await pair({ amount: 0.5, max: 1 });
    let claims = 0;
    const store: EnforcementStore = {
      claimMandate: () => {
        claims++;
        return true;
      },
      recordDecision: () => {},
    };
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.5,
      recover,
      store,
      gateConsentAboveUsd: 0.5,
    });
    expect(pdr.verdict).toBe("deny");
    expect(pdr.reasons.join()).toMatch(/consent_required/);
    expect(pdr.consumed).toBe(false);
    expect(claims).toBe(0); // denied before consume-once, so it can settle later with consent
  });

  it("gates: allows an at/above-threshold spend when consent is verified", async () => {
    const { intent, payment } = await pair({ amount: 0.5, max: 1 });
    const { consent, binding } = await withConsent();
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.5,
      recover,
      store,
      consent,
      binding,
      verifyEd25519: verifyOk,
      gateConsentAboveUsd: 0.5,
    });
    expect(pdr.verdict).toBe("allow");
    expect(pdr.reasons.join()).toMatch(/consent_verified/);
  });

  it("gates: denies at/above threshold when the consent is unverified", async () => {
    const { intent, payment } = await pair({ amount: 0.5, max: 1 });
    const { consent, binding } = await withConsent();
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.5,
      recover,
      store,
      consent,
      binding,
      verifyEd25519: () => false, // force consent verification to fail
      gateConsentAboveUsd: 0.5,
    });
    expect(pdr.verdict).toBe("deny");
    expect(pdr.reasons.join()).toMatch(/consent_required/);
  });

  it("gates: below the threshold, an unconsented spend still settles (additive)", async () => {
    const { intent, payment } = await pair({ amount: 0.25, max: 1 });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
      gateConsentAboveUsd: 0.5, // 0.25 < 0.5 => not gated
    });
    expect(pdr.verdict).toBe("allow");
  });

  it("stays additive when no threshold is set (default): unconsented spend allowed", async () => {
    const { intent, payment } = await pair({ amount: 5, max: 10 });
    const store = new InMemoryEnforcementStore();
    const pdr = await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 5,
      recover,
      store, // gateConsentAboveUsd undefined
    });
    expect(pdr.verdict).toBe("allow");
  });

  it("does not consume the mandate nonce when an earlier check fails", async () => {
    // A context-binding failure must not burn the nonce: a later correctly
    // addressed presentation of the same mandate should still be evaluable.
    const OTHER = "0x00000000000000000000000000000000000000bb";
    let claims = 0;
    const store: EnforcementStore = {
      claimMandate: () => {
        claims++;
        return true;
      },
      recordDecision: () => {},
    };
    const { intent, payment } = await pair({ payee: OTHER });
    await evaluate({
      payment,
      intent,
      expectedPayee: SELLER,
      expectedAmount: 0.25,
      recover,
      store,
    });
    expect(claims).toBe(0); // denied on context binding, before the consume step
  });
});
