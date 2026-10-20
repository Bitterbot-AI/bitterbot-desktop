import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildIdentityBinding,
  buildSpendConsent,
  resolveConsentRef,
  verifyIdentityBinding,
  type SignEd25519Fn,
  type VerifyEd25519Fn,
} from "./consent.js";

// Fixture secp256k1/EIP-191: signature is `w:<addr>:<sha(msg)>`; recover checks it.
const WALLET = "0x1593000000000000000000000000000000000000";
const CIRCLE = "ed25519:" + "ab".repeat(32);
const OTHER_CIRCLE = "ed25519:" + "cd".repeat(32);
const SELLER = "0x00000000000000000000000000000000000000aa";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const signWallet = async (msg: string) => `w:${WALLET.toLowerCase()}:${sha(msg)}`;
const recoverWallet = async (msg: string, sig: string) => {
  const m = /^w:(0x[0-9a-f]{40}):([0-9a-f]{64})$/.exec(sig);
  if (!m || m[2] !== sha(msg)) throw new Error("bad wallet sig");
  return m[1];
};
// Fixture Ed25519: signature is `<pubkey>:<sha(msg)>`; verify checks both.
const signCircleAs =
  (pubkey: string): SignEd25519Fn =>
  (msg) =>
    `${pubkey}:${sha(msg)}`;
const verifyEd25519: VerifyEd25519Fn = (msg, sig, pubkey) => sig === `${pubkey}:${sha(msg)}`;

async function fullBinding(pubkey = CIRCLE) {
  return buildIdentityBinding({
    walletAddress: WALLET,
    circlePubkey: pubkey,
    signWallet,
    signCircle: signCircleAs(pubkey),
  });
}
function consentFor(opts?: { max?: number; payees?: string[]; ttlMs?: number; pubkey?: string }) {
  const pubkey = opts?.pubkey ?? CIRCLE;
  return buildSpendConsent({
    walletAddress: WALLET,
    circlePubkey: pubkey,
    maxAmount: { amount: String(opts?.max ?? 1), currency: "USDC" },
    allowedPayees: opts?.payees ?? ["*"],
    ttlMs: opts?.ttlMs ?? 3_600_000,
    signCircle: signCircleAs(pubkey),
  });
}

describe("AP2 Circles consent lineage (PLAN-47 Phase 4.x)", () => {
  it("verifies a dual-signed identity binding", async () => {
    const b = await fullBinding();
    expect((await verifyIdentityBinding(b, { recoverWallet, verifyEd25519 })).ok).toBe(true);
  });

  it("rejects a binding whose circle signature is forged", async () => {
    const b = await fullBinding();
    b.sigByCircle = `${CIRCLE}:${"0".repeat(64)}`; // wrong hash
    expect((await verifyIdentityBinding(b, { recoverWallet, verifyEd25519 })).ok).toBe(false);
  });

  it("resolves a valid consent chain to verified:true", async () => {
    const res = await resolveConsentRef({
      consent: consentFor({ max: 1 }),
      binding: await fullBinding(),
      payerWallet: WALLET,
      payee: SELLER,
      amountUsd: 0.25,
      recoverWallet,
      verifyEd25519,
    });
    expect(res.verified).toBe(true);
    expect(res.consentRef).toMatch(/^consent:/);
  });

  it("rejects consent signed by a circle key not in the binding", async () => {
    // consent signed by OTHER_CIRCLE, binding on CIRCLE
    const res = await resolveConsentRef({
      consent: consentFor({ pubkey: OTHER_CIRCLE }),
      binding: await fullBinding(CIRCLE),
      payerWallet: WALLET,
      payee: SELLER,
      amountUsd: 0.25,
      recoverWallet,
      verifyEd25519,
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/circle key not in the binding|wallet/);
  });

  it("rejects when the payer wallet is not the consented wallet", async () => {
    const res = await resolveConsentRef({
      consent: consentFor(),
      binding: await fullBinding(),
      payerWallet: "0x9999000000000000000000000000000000009999",
      payee: SELLER,
      amountUsd: 0.25,
      recoverWallet,
      verifyEd25519,
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/payer/);
  });

  it("rejects a charge above the consent max_amount", async () => {
    const res = await resolveConsentRef({
      consent: consentFor({ max: 0.5 }),
      binding: await fullBinding(),
      payerWallet: WALLET,
      payee: SELLER,
      amountUsd: 2,
      recoverWallet,
      verifyEd25519,
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/max_amount/);
  });

  it("rejects a payee outside the consent allow-list", async () => {
    const res = await resolveConsentRef({
      consent: consentFor({ payees: ["0x00000000000000000000000000000000000000bb"] }),
      binding: await fullBinding(),
      payerWallet: WALLET,
      payee: SELLER,
      amountUsd: 0.25,
      recoverWallet,
      verifyEd25519,
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/payee/);
  });

  it("rejects an expired consent", async () => {
    const consent = consentFor({ ttlMs: 1000 });
    const res = await resolveConsentRef({
      consent,
      binding: await fullBinding(),
      payerWallet: WALLET,
      payee: SELLER,
      amountUsd: 0.25,
      recoverWallet,
      verifyEd25519,
      now: (consent.claims.exp + 10) * 1000,
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/expired/);
  });
});
