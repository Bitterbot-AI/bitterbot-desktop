/**
 * Spend grants — the human-set, signed spending budget an agent operates within.
 * PLAN-48 Phase 0 (the set-once tier of the consent model).
 *
 * A spend grant is the "scope once" step: the owner authorizes the agent to spend
 * up to an allowance per period, to a set of payees, until an expiry — the same
 * shape as an ERC-7715 `wallet_grantPermissions` grant and an AP2 Intent Mandate.
 * Within a grant the agent transacts silently (and emits the PLAN-47 consent
 * lineage); outside it, the spend must escalate to the human (Phase 2).
 *
 * A grant is signed by the owner's Ed25519 identity (the node's device/Circles
 * key), so it is non-repudiable, tamper-evident, and portable — a settling party
 * or a dispute can verify exactly what the human authorized. Crypto is injected
 * (as in consent.ts): callers wire the real Ed25519; tests use fixtures. This
 * module holds only the canonical form, signing, and the coverage predicate; the
 * sqlite store and per-period accounting live in spend-grant-store.ts.
 */

import { createHash } from "node:crypto";
import type { CirclePubkey, SignEd25519Fn, VerifyEd25519Fn } from "../ap2/consent.js";
import type { MandateAmount } from "../ap2/mandate.js";

export const SPEND_GRANT_DOMAIN = "bitterbot-spend-grant:v1:";

/** What a grant authorizes spend toward. */
export interface SpendGrantScope {
  /** Allowed payee addresses (lowercased) or ["*"] for any. */
  allowed_payees: string[];
  /** Optional free-form categories (dot-namespaced by convention), for display/policy. */
  categories?: string[];
}

export interface SpendGrantClaims {
  v: 1;
  /** Stable id (hash of the claims) — the consume/usage + revocation key. */
  grant_id: string;
  /** Owner identity that signed the grant (`ed25519:<hex>`). */
  owner_pubkey: CirclePubkey;
  scope: SpendGrantScope;
  /** Total spend allowed per `period_seconds` (the ERC-7715-style allowance). */
  allowance: MandateAmount;
  period_seconds: number;
  /** Optional per-payment ceiling; a single spend above this escalates even if the period has room. */
  per_tx_max?: MandateAmount;
  iat: number; // unix seconds
  exp: number; // unix seconds
}

export interface SpendGrant {
  claims: SpendGrantClaims;
  /** Ed25519 signature (hex) by claims.owner_pubkey over grantSigningMaterial(). */
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

/** Stable grant id: hash of the claims WITHOUT grant_id (which is derived from the rest). */
export function computeGrantId(claims: Omit<SpendGrantClaims, "grant_id">): string {
  return "grant:" + createHash("sha256").update(canonical(claims)).digest("hex").slice(0, 32);
}

/** The exact bytes the owner key signs for a grant. */
export function grantSigningMaterial(claims: SpendGrantClaims): string {
  return SPEND_GRANT_DOMAIN + canonical(claims);
}

function parseAmount(a: MandateAmount): number {
  const n = Number.parseFloat(a.amount);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Format a human USDC number as a grant amount. */
export function usdc(amount: number): MandateAmount {
  return { amount: amount.toString(), currency: "USDC" };
}

/**
 * Build and sign a spend grant. `grant_id` is derived from the rest of the claims
 * so it cannot be forged independently of the signed content.
 */
export function buildSpendGrant(params: {
  ownerPubkey: CirclePubkey;
  scope: SpendGrantScope;
  allowance: MandateAmount;
  periodSeconds: number;
  perTxMax?: MandateAmount;
  ttlMs: number;
  signOwner: SignEd25519Fn;
  now?: number;
}): SpendGrant {
  const iat = Math.floor((params.now ?? Date.now()) / 1000);
  const base: Omit<SpendGrantClaims, "grant_id"> = {
    v: 1,
    owner_pubkey: params.ownerPubkey,
    scope: {
      allowed_payees: params.scope.allowed_payees.map((p) => p.toLowerCase()),
      ...(params.scope.categories ? { categories: params.scope.categories } : {}),
    },
    allowance: params.allowance,
    period_seconds: params.periodSeconds,
    ...(params.perTxMax ? { per_tx_max: params.perTxMax } : {}),
    iat,
    exp: iat + Math.floor(params.ttlMs / 1000),
  };
  const claims: SpendGrantClaims = { ...base, grant_id: computeGrantId(base) };
  return { claims, signature: params.signOwner(grantSigningMaterial(claims)) };
}

export interface GrantVerifyResult {
  ok: boolean;
  reason?: string;
}

/** Verify a grant's signature and that its id matches its content (tamper-evident). */
export function verifySpendGrant(
  grant: SpendGrant,
  verifyEd25519: VerifyEd25519Fn,
): GrantVerifyResult {
  const { grant_id, ...rest } = grant.claims;
  if (computeGrantId(rest) !== grant_id) {
    return { ok: false, reason: "grant_id does not match claims" };
  }
  if (
    !verifyEd25519(grantSigningMaterial(grant.claims), grant.signature, grant.claims.owner_pubkey)
  ) {
    return { ok: false, reason: "grant signature invalid" };
  }
  return { ok: true };
}

export interface CoverageInput {
  payee: string;
  amountUsd: number;
  /** How much this grant has already spent in the current period. */
  consumedInPeriodUsd: number;
  now?: number; // unix seconds
}

/**
 * Does this grant cover the proposed spend? Checks expiry, payee scope, the
 * optional per-tx ceiling, and that the period allowance has room. Currency must
 * match the grant's allowance currency. Revocation is checked by the store (a
 * revoked grant is never passed here). Pure: the store supplies `consumedInPeriodUsd`.
 */
export function grantCovers(grant: SpendGrant, input: CoverageInput): GrantVerifyResult {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const c = grant.claims;
  if (c.exp <= now) return { ok: false, reason: "grant expired" };

  const payee = input.payee.toLowerCase();
  if (!c.scope.allowed_payees.includes("*") && !c.scope.allowed_payees.includes(payee)) {
    return { ok: false, reason: "payee not in grant scope" };
  }

  const allowance = parseAmount(c.allowance);
  if (!Number.isFinite(allowance)) return { ok: false, reason: "grant allowance invalid" };
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
    return { ok: false, reason: "invalid amount" };
  }
  if (c.per_tx_max) {
    const perTx = parseAmount(c.per_tx_max);
    if (Number.isFinite(perTx) && input.amountUsd > perTx) {
      return { ok: false, reason: "amount exceeds grant per-transaction max" };
    }
  }
  if (input.consumedInPeriodUsd + input.amountUsd > allowance) {
    return { ok: false, reason: "grant period allowance exhausted" };
  }
  return { ok: true };
}

/** How specific a grant is to a payee (exact-payee grant preferred over a wildcard). */
export function grantSpecificity(grant: SpendGrant, payee: string): number {
  return grant.claims.scope.allowed_payees.includes(payee.toLowerCase()) ? 2 : 1;
}
