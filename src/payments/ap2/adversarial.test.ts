/**
 * PLAN-47 adversarial pass — attacks on the mandate + enforcement layer.
 * Each test corresponds to a finding; the first two assert the hardenings hold,
 * the third documents an accepted limitation (finding C) as an executable note.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryEnforcementStore, evaluate } from "./enforcement.js";
import {
  canonicalizeClaims,
  issueIntentMandate,
  issuePaymentMandate,
  signingMaterial,
  usdc,
  verifyMandate,
  type PaymentMandateClaims,
  type RecoverFn,
} from "./mandate.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const AGENT = "0x1593000000000000000000000000000000000000";
const SELLER = "0x00000000000000000000000000000000000000aa";

// A deterministic fixture signer (as elsewhere).
const signer = async (canonical: string) => `valid:${AGENT}:${sha(canonical)}`;
// A NON-deterministic signer: appends a random nonce the recover fn ignores, so
// two signatures over identical content differ — modelling real ECDSA (random k).
const nonceSigner = async (canonical: string) =>
  `valid:${AGENT}:${sha(canonical)}:${Math.random()}`;
const recover: RecoverFn = async (canonical, signature) => {
  const m = /^valid:(0x[a-fA-F0-9]{40}):([0-9a-f]{64})(?::.*)?$/.exec(signature);
  if (!m) throw new Error("malformed signature");
  if (m[2] !== sha(canonical)) throw new Error("signature does not cover these claims");
  return m[1];
};

async function intentFor() {
  return issueIntentMandate({
    agentAddress: AGENT,
    maxAmount: usdc(1),
    ttlMs: 3_600_000,
    sign: signer,
  });
}

describe("PLAN-47 adversarial pass", () => {
  // Finding A: domain separation. A signature made over the claims WITHOUT the
  // mandate domain prefix (e.g. an x402-token-style signature) must not verify
  // as a mandate.
  it("A — rejects a mandate signed without the domain separator", async () => {
    const intent = await intentFor();
    const claims = intent.claims;
    const noDomainSig = `valid:${AGENT}:${sha(canonicalizeClaims(claims))}`; // missing domain
    const forged = { claims, signature: noDomainSig, signer: AGENT };
    const r = await verifyMandate(forged, { recover });
    expect(r.valid).toBe(false); // recover over signingMaterial != the no-domain hash
    // sanity: the same claims signed WITH the domain do verify.
    const good = {
      claims,
      signature: `valid:${AGENT}:${sha(signingMaterial(claims))}`,
      signer: AGENT,
    };
    expect((await verifyMandate(good, { recover })).valid).toBe(true);
  });

  // Finding B: consume-once must key on claims content, not the signature, so a
  // re-signed replay of identical claims is still caught.
  it("B — denies a re-signed replay of identical claims (content-keyed nonce)", async () => {
    const intent = await intentFor();
    const payment = await issuePaymentMandate({
      intent,
      agentAddress: AGENT,
      payee: { id: SELLER },
      amount: usdc(0.25),
      instrument: { id: AGENT, type: "x402-usdc" },
      transactionId: "0xreplay",
      ttlMs: 300_000,
      sign: nonceSigner,
    });
    // Re-sign the SAME claims with a fresh (different) valid signature.
    const reSigned = {
      claims: payment.claims as PaymentMandateClaims,
      signature: await nonceSigner(signingMaterial(payment.claims)),
      signer: AGENT,
    };
    expect(reSigned.signature).not.toBe(payment.signature); // genuinely different sig

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
      payment: reSigned,
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

  // Finding C (a stripped/absent mandate is not blocked) is an accepted posture,
  // documented in enforcement.ts KNOWN LIMITATION rather than asserted here — the
  // gate only ever constrains a mandate that is present.
});
