/**
 * AP2 (Agent Payments Protocol) mandates over Bitterbot's x402 rail. PLAN-47 Phase 1.
 *
 * SOTA agent payments split into two layers that compose: signed *mandates*
 * authorize (Google AP2), stablecoins *settle* (x402/USDC). Bitterbot already
 * runs Coinbase x402 (src/services/x402-verify.ts, src/services/a2a-client.ts);
 * this module adds the missing authorization layer — a cryptographically signed
 * proof that the user (or, in autonomous mode, the agent under a delegated
 * budget) authorized *this* spend, within stated limits.
 *
 * We model AP2's real claim vocabulary (verbatim `vct` values, `iat`/`exp`,
 * `cnf`, `payee`, `payment_amount`, `payment_instrument`, `transaction_id`,
 * `constraints`) so a mandate we emit is legible to the AP2 ecosystem.
 *
 * WIRE-FORMAT NOTE (D-1, deliberately deferred): AP2's canonical encoding is an
 * SD-JWT signed with a P-256 (ES256) key, with the agent key expressed as a JWK
 * in `cnf`. Phase 1 signs the *canonical JSON* of the claims with the agent's
 * existing, production-proven secp256k1 / EIP-191 key (the same
 * walletService.signMessage that already signs x402 tokens) and expresses the
 * key as an eip155 address in `cnf`. This keeps the signer single and proven.
 * Swapping to a P-256 SD-JWT signer for full wire-interop with third-party AP2
 * verifiers is isolated to `canonicalizeClaims` + the injected sign/recover
 * functions and the `cnf` shape — nothing else in the codebase changes. Until
 * then, a Bitterbot mandate is AP2-*modeled* and self-verifiable, not yet
 * cross-verifiable by a P-256-only AP2 verifier.
 *
 * SCOPE (Phase 1): emit + verify + mandate-chain constraint enforcement (I1).
 * The runtime enforcement AP2 leaves to deployments — consume-once (nonce/
 * idempotency) and execution-time context binding — is Phase 4 and lives in the
 * enforcement gate, not here. A mandate verified here proves authenticity and
 * that it has not expired; it does NOT by itself prove it has not been replayed.
 */

import { createHash } from "node:crypto";

/** AP2 verifiable-credential type tags (verbatim from the AP2 spec). */
export const AP2_VCT = {
  /** Open ("intent") payment mandate: delegated authority under constraints. */
  intent: "mandate.payment.open.1",
  /** Closed payment mandate: authorization of one specific charge. */
  payment: "mandate.payment.1",
} as const;

/** A monetary amount, AP2-style: decimal string + ISO-ish currency code. */
export interface MandateAmount {
  amount: string;
  currency: string;
}

/** Agent key confirmation. AP2 uses `cnf.jwk` (P-256); Phase 1 uses an address. */
export interface KeyConfirmation {
  /** Lowercased 0x eip155 address of the signing agent key. */
  eip155Address: string;
}

/**
 * Intent (open) mandate — the delegated budget. In autonomous mode the agent
 * self-issues this to bound its own spend; a human-present flow would have the
 * user sign it. Constraints are the ceiling every derived Payment mandate must
 * fall within.
 */
export interface IntentMandateClaims {
  vct: typeof AP2_VCT.intent;
  iat: number; // issued-at, unix seconds
  exp: number; // expiry, unix seconds
  cnf: KeyConfirmation;
  constraints: {
    /** Per-payment ceiling. A derived Payment mandate above this is refused. */
    max_amount: MandateAmount;
    /** Optional aggregate ceiling across the intent's lifetime (e.g. daily). */
    total_amount?: MandateAmount;
    /** Allowed payee addresses (lowercased) or ["*"] for any. Default: any. */
    allowed_payees?: string[];
    /** The agent's natural-language understanding of the delegation (AP2 "prompt playback"). */
    prompt_playback?: string;
  };
}

/**
 * Payment (closed) mandate — authorization of one concrete charge, bound back
 * to the Intent mandate it was derived from via `intent_ref`.
 */
export interface PaymentMandateClaims {
  vct: typeof AP2_VCT.payment;
  /** The on-chain settlement identifier (x402 txHash) or a uuid pre-settlement. */
  transaction_id: string;
  iat: number;
  exp: number;
  cnf: KeyConfirmation;
  payee: { id: string; name?: string; website?: string };
  payment_amount: MandateAmount;
  payment_instrument: { id: string; type: string; description?: string };
  /**
   * Hash of the signed Intent mandate this payment draws on. AP2 chains a
   * closed mandate to an open one by a matching hash in the delegate chain
   * (the `conditional_transaction_id` mechanism); this is that link.
   */
  intent_ref: string;
  /**
   * Optional id of the Circles spend-consent this payment traces to
   * (src/payments/ap2/consent.ts). Signed as part of the mandate so the
   * reference can't be swapped; the consent artifact + identity binding travel
   * alongside the mandate for the settling party to verify. Absent on mandates
   * emitted without consent lineage.
   */
  consent_ref?: string;
}

/** A signed mandate: the claims, the agent signature, and the declared signer. */
export interface MandateEnvelope<TClaims> {
  claims: TClaims;
  /** Agent signature over signingMaterial(claims) (domain + canonical claims). */
  signature: string;
  /** Declared signer address; must equal claims.cnf.eip155Address and the recovered signer. */
  signer: string;
}

/** Thrown when a Payment mandate would exceed or violate its Intent's constraints (I1). */
export class MandateConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MandateConstraintError";
  }
}

export type SignFn = (canonical: string) => Promise<string>;
/** Recover the signer address from a signature over `canonical`. */
export type RecoverFn = (canonical: string, signature: string) => Promise<string>;

/**
 * Domain separator prepended to every mandate before signing (adversarial-pass
 * hardening). The agent's `signMessage` is a general EIP-191 signer also used
 * for x402 payment tokens; tagging the signed bytes with a mandate-specific,
 * versioned domain means a mandate signature can never be confused with — or
 * replayed as — a signature over any other kind of message, and vice versa.
 */
export const AP2_MANDATE_DOMAIN = "bitterbot-ap2-mandate:v1:";

/**
 * Deterministic canonical encoding of claims for signing/verifying. Keys are
 * emitted in sorted order at every level so the same claims always produce the
 * same bytes. (AP2 wire-interop would replace this with SD-JWT; see file header.)
 */
export function canonicalizeClaims(claims: unknown): string {
  return JSON.stringify(sortDeep(claims));
}

/** The exact bytes that get signed/recovered for a mandate: domain + canonical claims. */
export function signingMaterial(claims: unknown): string {
  return AP2_MANDATE_DOMAIN + canonicalizeClaims(claims);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable hash of a signed mandate envelope, used as the intent_ref link. */
export function mandateHash<T>(env: MandateEnvelope<T>): string {
  const material = canonicalizeClaims({ claims: env.claims, signature: env.signature });
  return "sha256:" + createHash("sha256").update(material).digest("hex");
}

/**
 * Content id of a mandate: a hash of its CLAIMS ONLY (not the signature). This
 * is the consume-once key (adversarial-pass hardening): keying on the signature
 * would let a re-signed replay of identical claims slip past the nonce, since
 * ECDSA signatures are not deterministic. Two genuinely distinct payments differ
 * in `transaction_id`, so their content ids differ; a replay of the same
 * authorization has the same content id and is caught regardless of signature.
 */
export function mandateContentId(claims: unknown): string {
  return "sha256:" + createHash("sha256").update(canonicalizeClaims(claims)).digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function parseAmount(a: MandateAmount): number {
  const n = Number.parseFloat(a.amount);
  if (!Number.isFinite(n) || n < 0) {
    throw new MandateConstraintError(`invalid mandate amount: ${a.amount}`);
  }
  return n;
}

/** Format a human USDC number as an AP2 amount. */
export function usdc(amount: number): MandateAmount {
  return { amount: amount.toString(), currency: "USDC" };
}

/**
 * Issue (self-sign) an Intent mandate encoding a delegated spend budget.
 * `agentAddress` is the signer; `sign` is the agent's message signer.
 */
export async function issueIntentMandate(params: {
  agentAddress: string;
  maxAmount: MandateAmount;
  totalAmount?: MandateAmount;
  allowedPayees?: string[];
  promptPlayback?: string;
  ttlMs: number;
  sign: SignFn;
}): Promise<MandateEnvelope<IntentMandateClaims>> {
  const signer = params.agentAddress.toLowerCase();
  const iat = nowSeconds();
  const claims: IntentMandateClaims = {
    vct: AP2_VCT.intent,
    iat,
    exp: iat + Math.floor(params.ttlMs / 1000),
    cnf: { eip155Address: signer },
    constraints: {
      max_amount: params.maxAmount,
      ...(params.totalAmount ? { total_amount: params.totalAmount } : {}),
      ...(params.allowedPayees
        ? { allowed_payees: params.allowedPayees.map((p) => p.toLowerCase()) }
        : {}),
      ...(params.promptPlayback ? { prompt_playback: params.promptPlayback } : {}),
    },
  };
  const signature = await params.sign(signingMaterial(claims));
  return { claims, signature, signer };
}

/**
 * Derive and sign a Payment mandate from an Intent mandate for one concrete
 * charge. Enforces the intent's constraints at emit time (invariant I1): a
 * payment over `max_amount`, in a mismatched currency, or to a disallowed payee
 * throws MandateConstraintError rather than producing a signed over-authorization.
 */
export async function issuePaymentMandate(params: {
  intent: MandateEnvelope<IntentMandateClaims>;
  agentAddress: string;
  payee: { id: string; name?: string; website?: string };
  amount: MandateAmount;
  instrument: { id: string; type: string; description?: string };
  transactionId: string;
  ttlMs: number;
  /** Optional Circles spend-consent id to bind into the mandate (consent lineage). */
  consentRef?: string;
  sign: SignFn;
}): Promise<MandateEnvelope<PaymentMandateClaims>> {
  const signer = params.agentAddress.toLowerCase();
  const c = params.intent.claims.constraints;

  if (params.amount.currency !== c.max_amount.currency) {
    throw new MandateConstraintError(
      `payment currency ${params.amount.currency} != intent currency ${c.max_amount.currency}`,
    );
  }
  if (parseAmount(params.amount) > parseAmount(c.max_amount)) {
    throw new MandateConstraintError(
      `payment ${params.amount.amount} ${params.amount.currency} exceeds intent max ${c.max_amount.amount}`,
    );
  }
  const payeeId = params.payee.id.toLowerCase();
  if (c.allowed_payees && !c.allowed_payees.includes("*") && !c.allowed_payees.includes(payeeId)) {
    throw new MandateConstraintError(`payee ${payeeId} not in intent allowed_payees`);
  }

  const iat = nowSeconds();
  const claims: PaymentMandateClaims = {
    vct: AP2_VCT.payment,
    transaction_id: params.transactionId,
    iat,
    exp: iat + Math.floor(params.ttlMs / 1000),
    cnf: { eip155Address: signer },
    payee: { ...params.payee, id: payeeId },
    payment_amount: params.amount,
    payment_instrument: params.instrument,
    intent_ref: mandateHash(params.intent),
    ...(params.consentRef ? { consent_ref: params.consentRef } : {}),
  };
  const signature = await params.sign(signingMaterial(claims));
  return { claims, signature, signer };
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Verify a mandate's *static* guarantees: the signature recovers to the declared
 * signer and to `cnf.eip155Address`, and the mandate has not expired. This is
 * authenticity + expiry only — consume-once and context binding are Phase 4.
 */
export async function verifyMandate<T extends { cnf: KeyConfirmation; exp: number; vct: string }>(
  env: MandateEnvelope<T>,
  opts: { recover: RecoverFn; now?: number },
): Promise<VerifyResult> {
  const now = opts.now ?? nowSeconds();
  if (!env.claims.vct) return { valid: false, error: "mandate missing vct" };
  if (typeof env.claims.exp !== "number" || env.claims.exp <= now) {
    return { valid: false, error: "mandate expired" };
  }
  const declared = env.signer.toLowerCase();
  if (env.claims.cnf.eip155Address.toLowerCase() !== declared) {
    return { valid: false, error: "cnf key does not match declared signer" };
  }
  let recovered: string;
  try {
    recovered = await opts.recover(signingMaterial(env.claims), env.signature);
  } catch (err) {
    return { valid: false, error: `signature recover failed: ${String(err)}` };
  }
  if (recovered.toLowerCase() !== declared) {
    return { valid: false, error: "signature does not match declared signer" };
  }
  return { valid: true };
}

/**
 * Verify a Payment mandate against the Intent it claims to draw on: both
 * signatures valid and unexpired, the payment is chained to this exact intent
 * (`intent_ref` matches), signed by the same agent key, and still within the
 * intent's per-payment ceiling and payee allow-list. The full mandate-chain
 * check a settling party runs.
 */
export async function verifyPaymentAgainstIntent(params: {
  payment: MandateEnvelope<PaymentMandateClaims>;
  intent: MandateEnvelope<IntentMandateClaims>;
  recover: RecoverFn;
  now?: number;
}): Promise<VerifyResult> {
  const intentOk = await verifyMandate(params.intent, { recover: params.recover, now: params.now });
  if (!intentOk.valid) return { valid: false, error: `intent: ${intentOk.error}` };
  const payOk = await verifyMandate(params.payment, { recover: params.recover, now: params.now });
  if (!payOk.valid) return { valid: false, error: `payment: ${payOk.error}` };

  if (params.payment.claims.intent_ref !== mandateHash(params.intent)) {
    return { valid: false, error: "payment intent_ref does not match provided intent" };
  }
  if (
    params.payment.claims.cnf.eip155Address.toLowerCase() !==
    params.intent.claims.cnf.eip155Address.toLowerCase()
  ) {
    return { valid: false, error: "payment and intent signed by different agent keys" };
  }
  const pay = params.payment.claims.payment_amount;
  const max = params.intent.claims.constraints.max_amount;
  if (pay.currency !== max.currency) {
    return { valid: false, error: "payment currency does not match intent" };
  }
  if (parseAmount(pay) > parseAmount(max)) {
    return { valid: false, error: "payment exceeds intent max_amount" };
  }
  const allowed = params.intent.claims.constraints.allowed_payees;
  if (
    allowed &&
    !allowed.includes("*") &&
    !allowed.includes(params.payment.claims.payee.id.toLowerCase())
  ) {
    return { valid: false, error: "payee not permitted by intent" };
  }
  return { valid: true };
}
