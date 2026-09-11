/**
 * Circles consent lineage for AP2 payments — the "moat" that an AP2-only stack
 * cannot produce. PLAN-47 Phase 4.x.
 *
 * A standard AP2 mandate proves "the agent had a valid, in-budget authorization
 * to pay." This module adds the layer above that: a cryptographically verifiable
 * chain from the payment back to a consent the node's owner-controlled identity
 * signed. A settling party can then check not just "valid mandate" but "this
 * spend traces to a consent signed by the same principal that controls the
 * paying wallet."
 *
 * The hard part is that the two identities use different keys:
 *   - the MANDATE is signed by the wallet's secp256k1 / EIP-191 key (cnf.eip155Address)
 *   - CONSENT lives in Circles, signed by the node's Ed25519 device identity
 * They are the same principal but have no cryptographic link on their own. The
 * IDENTITY BINDING below is that link: a statement signed by BOTH keys, so a
 * verifier can prove the Ed25519 key that signed the consent controls the
 * secp256k1 wallet that signed the mandate.
 *
 * All crypto is injected (like the signer in mandate.ts): callers wire the real
 * secp256k1 (walletService.signMessage / viem recover) and Ed25519 (device key)
 * implementations; tests use fixtures. This module holds only the canonical
 * forms and the verification logic.
 */

import { createHash } from "node:crypto";

export const IDENTITY_BINDING_DOMAIN = "bitterbot-identity-binding:v1:";
export const SPEND_CONSENT_DOMAIN = "bitterbot-spend-consent:v1:";

/** ed25519 pubkey in the Circles form `ed25519:<64 hex>`. */
export type CirclePubkey = string;

export type RecoverWalletFn = (message: string, signature: string) => Promise<string>;
export type SignWalletFn = (message: string) => Promise<string>;
/** Verify an Ed25519 signature (hex) over `message` for `pubkey` (`ed25519:<hex>`). */
export type VerifyEd25519Fn = (
  message: string,
  signatureHex: string,
  pubkey: CirclePubkey,
) => boolean;
export type SignEd25519Fn = (message: string) => string;

/**
 * A statement, signed by BOTH the wallet key and the circle key, asserting they
 * belong to the same principal. This is the bridge the verifier trusts.
 */
export interface IdentityBinding {
  walletAddress: string; // lowercased eip155 address (secp256k1)
  circlePubkey: CirclePubkey; // ed25519:<hex>
  /** secp256k1/EIP-191 signature by the wallet key over bindingStatement(). */
  sigByWallet: string;
  /** ed25519 signature (hex) by the circle key over bindingStatement(). */
  sigByCircle: string;
}

/** The exact bytes both keys sign to bind themselves together. */
export function bindingStatement(walletAddress: string, circlePubkey: CirclePubkey): string {
  return `${IDENTITY_BINDING_DOMAIN}${walletAddress.toLowerCase()}:${circlePubkey}`;
}

/** A spend consent, signed by the node's circle (Ed25519) identity. */
export interface SpendConsentClaims {
  v: 1;
  /** The wallet this consent authorizes spend from (lowercased). */
  wallet: string;
  /** The circle identity that signed it (`ed25519:<hex>`). */
  circle_pubkey: CirclePubkey;
  /** Max per-payment amount authorized. */
  max_amount: { amount: string; currency: string };
  /** Allowed payees (lowercased) or ["*"]. */
  allowed_payees: string[];
  /** Optional id of the human-set spend grant that authorized this consent (PLAN-48). */
  grant_ref?: string;
  iat: number; // unix seconds
  exp: number; // unix seconds
}

export interface SpendConsent {
  claims: SpendConsentClaims;
  /** ed25519 signature (hex) by claims.circle_pubkey over consentSigningMaterial(). */
  signature: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .toSorted()
        .map((k) => JSON.stringify(k) + ":" + canonical(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/** The exact bytes the circle key signs for a spend consent. */
export function consentSigningMaterial(claims: SpendConsentClaims): string {
  return SPEND_CONSENT_DOMAIN + canonical(claims);
}

/** Stable id of a consent (hash of its claims) — what a mandate's consent_ref points at. */
export function consentId(claims: SpendConsentClaims): string {
  return "consent:" + createHash("sha256").update(canonical(claims)).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Produce (buyer side) — assemble the binding + consent from the node's two keys.
// ---------------------------------------------------------------------------

export async function buildIdentityBinding(params: {
  walletAddress: string;
  circlePubkey: CirclePubkey;
  signWallet: SignWalletFn;
  signCircle: SignEd25519Fn;
}): Promise<IdentityBinding> {
  const stmt = bindingStatement(params.walletAddress, params.circlePubkey);
  return {
    walletAddress: params.walletAddress.toLowerCase(),
    circlePubkey: params.circlePubkey,
    sigByWallet: await params.signWallet(stmt),
    sigByCircle: params.signCircle(stmt),
  };
}

export function buildSpendConsent(params: {
  walletAddress: string;
  circlePubkey: CirclePubkey;
  maxAmount: { amount: string; currency: string };
  allowedPayees: string[];
  grantRef?: string;
  ttlMs: number;
  signCircle: SignEd25519Fn;
  now?: number;
}): SpendConsent {
  const iat = Math.floor((params.now ?? Date.now()) / 1000);
  const claims: SpendConsentClaims = {
    v: 1,
    wallet: params.walletAddress.toLowerCase(),
    circle_pubkey: params.circlePubkey,
    max_amount: params.maxAmount,
    allowed_payees: params.allowedPayees.map((p) => p.toLowerCase()),
    ...(params.grantRef ? { grant_ref: params.grantRef } : {}),
    iat,
    exp: iat + Math.floor(params.ttlMs / 1000),
  };
  return { claims, signature: params.signCircle(consentSigningMaterial(claims)) };
}

// ---------------------------------------------------------------------------
// Verify (seller side) — the full lineage check.
// ---------------------------------------------------------------------------

export interface ConsentResolution {
  /** The consent id to stamp into the Policy Decision Record. */
  consentRef: string;
  /** True only if the full chain (binding + consent + payer match) verifies. */
  verified: boolean;
  reason?: string;
}

export async function verifyIdentityBinding(
  binding: IdentityBinding,
  deps: { recoverWallet: RecoverWalletFn; verifyEd25519: VerifyEd25519Fn },
): Promise<{ ok: boolean; reason?: string }> {
  const stmt = bindingStatement(binding.walletAddress, binding.circlePubkey);
  let recovered: string;
  try {
    recovered = await deps.recoverWallet(stmt, binding.sigByWallet);
  } catch (err) {
    return { ok: false, reason: `binding wallet sig recover failed: ${String(err)}` };
  }
  if (recovered.toLowerCase() !== binding.walletAddress.toLowerCase()) {
    return { ok: false, reason: "binding wallet signature does not match walletAddress" };
  }
  if (!deps.verifyEd25519(stmt, binding.sigByCircle, binding.circlePubkey)) {
    return { ok: false, reason: "binding circle signature invalid" };
  }
  return { ok: true };
}

/**
 * Resolve the consent lineage for a payment: the binding ties wallet<->circle,
 * the consent is signed by that circle key, and the consent authorizes spend
 * from the same wallet the mandate was signed by (`payerWallet` = mandate cnf),
 * within amount/payee/expiry. Returns the consent id plus whether it verified.
 * A present-but-invalid consent returns verified:false with a reason (the gate
 * records it in the PDR; whether that blocks is the gate's policy, not ours).
 */
export async function resolveConsentRef(params: {
  consent: SpendConsent;
  binding: IdentityBinding;
  payerWallet: string;
  payee: string;
  amountUsd: number;
  recoverWallet: RecoverWalletFn;
  verifyEd25519: VerifyEd25519Fn;
  now?: number;
}): Promise<ConsentResolution> {
  const ref = consentId(params.consent.claims);
  const now = Math.floor((params.now ?? Date.now()) / 1000);
  const fail = (reason: string): ConsentResolution => ({
    consentRef: ref,
    verified: false,
    reason,
  });

  const bindOk = await verifyIdentityBinding(params.binding, {
    recoverWallet: params.recoverWallet,
    verifyEd25519: params.verifyEd25519,
  });
  if (!bindOk.ok) return fail(bindOk.reason ?? "binding invalid");

  const c = params.consent.claims;
  if (!params.verifyEd25519(consentSigningMaterial(c), params.consent.signature, c.circle_pubkey)) {
    return fail("consent signature invalid");
  }
  if (c.circle_pubkey !== params.binding.circlePubkey) {
    return fail("consent signed by a circle key not in the binding");
  }
  if (c.wallet.toLowerCase() !== params.binding.walletAddress.toLowerCase()) {
    return fail("consent wallet != bound wallet");
  }
  if (c.wallet.toLowerCase() !== params.payerWallet.toLowerCase()) {
    return fail("consent wallet != mandate signer (payer)");
  }
  if (typeof c.exp !== "number" || c.exp <= now) return fail("consent expired");

  const max = Number.parseFloat(c.max_amount.amount);
  if (!Number.isFinite(max) || params.amountUsd > max)
    return fail("charge exceeds consent max_amount");
  if (!c.allowed_payees.includes("*") && !c.allowed_payees.includes(params.payee.toLowerCase())) {
    return fail("payee not permitted by consent");
  }
  return { consentRef: ref, verified: true };
}
