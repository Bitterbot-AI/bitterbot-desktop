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
