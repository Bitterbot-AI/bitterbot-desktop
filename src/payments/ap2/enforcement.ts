/**
 * AP2 runtime enforcement — consume-once, context binding, Policy Decision
 * Records. PLAN-47 Phase 4 (the open frontier / "the moat").
 *
 * AP2's spec provides only STATIC mandate guarantees: a signature verifies and
 * the mandate has not expired (src/payments/ap2/mandate.ts). It deliberately
 * leaves two runtime checks to deployments, and every 2026 AP2 security analysis
 * flags the gap:
 *
 *   1. CONSUME-ONCE (nonce / idempotency). A cryptographically valid Payment
 *      mandate can be replayed — its signature stays valid — unless a registry
 *      records that it has already been acted on. (Invariant I2, mandate-scoped.)
 *   2. CONTEXT BINDING. A mandate authorizing "pay merchant X" can be redirected
 *      to merchant Y while its signature stays valid (AP2 Context-Binding-Failure)
 *      unless the settling party checks the mandate's declared `payee` against the
 *      actual settlement recipient. (Invariant I3, mandate-scoped.)
 *
 * This module is that runtime verifier. `evaluate()` takes a mandate pair plus
 * the real settlement context, runs verify -> context -> amount -> consume (in
 * that order, so a failed check never burns the nonce), and returns a Policy
 * Decision Record (I6): an auditable, persisted allow/deny with its reasons.
 *
 * It is the NEW guarantee over x402-verify.ts: that module binds the x402 *token*
 * to an on-chain Transfer to our wallet and consumes the txHash once; this binds
 * the *mandate* to that settlement and consumes the mandate once, and refuses a
 * mandate whose declared payee is not the party actually being paid.
 *
 * The store is injected (like the signer in mandate.ts): unit tests use the
 * in-memory store; production uses the sqlite-backed store over the marketplace
 * DB. Circles composition: a PDR carries an optional `consentRef` linking the
 * authorizing Circles signed-state consent envelope — the lineage an AP2-only
 * deployment cannot produce. (Populating it from a live Circles envelope is a
 * follow-up; the field and passthrough exist here.)
 */

import { createHash } from "node:crypto";
import {
  mandateHash,
  verifyPaymentAgainstIntent,
  type IntentMandateClaims,
  type MandateEnvelope,
  type PaymentMandateClaims,
  type RecoverFn,
} from "./mandate.js";

export type PolicyVerdict = "allow" | "deny";

/** An auditable record of one enforcement decision (invariant I6). */
export interface PolicyDecisionRecord {
  /** Stable id of the payment mandate (its hash) — the consume-once key. */
  mandateId: string;
  transactionId: string;
  verdict: PolicyVerdict;
  /** Machine-readable reasons; empty on a clean allow. */
  reasons: string[];
  /** The payee the mandate authorized (lowercased). */
  payee: string;
  /** Authorized amount + currency, as stated in the mandate. */
  amount: { amount: string; currency: string };
  /** Agent key (cnf) that signed the mandate. */
  agent: string;
  /** Hash linking the payment to its intent mandate. */
  intentRef: string;
  /** Whether this decision consumed the mandate nonce. */
  consumed: boolean;
  /** Optional Circles consent-envelope id this spend traces to. */
  consentRef?: string;
  /** Decision time, unix ms. */
  timestamp: number;
}

/**
 * Persistence for enforcement. `claimMandate` is the race-free consume-once
 * authority: it returns true only for the call that first claims `mandateId`.
 */
export interface EnforcementStore {
  /** Atomically claim a mandate id. Returns true if newly claimed, false if already consumed. */
  claimMandate(mandateId: string, now: number): boolean;
  /** Persist a decision record. */
  recordDecision(pdr: PolicyDecisionRecord): void;
}

function parse(amount: string): number {
  const n = Number.parseFloat(amount);
  return Number.isFinite(n) ? n : NaN;
}

export interface EvaluateParams {
  payment: MandateEnvelope<PaymentMandateClaims>;
  intent: MandateEnvelope<IntentMandateClaims>;
  /** The party actually being paid (our receiving address) — context binding target. */
  expectedPayee: string;
  /** The amount actually being charged; the mandate must authorize at least this. */
  expectedAmount: number;
  expectedCurrency?: string;
  recover: RecoverFn;
  store: EnforcementStore;
  /** Optional Circles consent-envelope id to stamp into the PDR. */
  consentRef?: string;
  now?: number;
}

/**
 * Evaluate a mandate pair against a concrete settlement and return a Policy
 * Decision Record. Order matters: authenticity -> context -> amount -> (last)
 * consume-once, so a mandate is only ever consumed on an otherwise-clean allow.
 */
export async function evaluate(params: EvaluateParams): Promise<PolicyDecisionRecord> {
  const now = params.now ?? Date.now();
  const claims = params.payment.claims;
  const mandateId = mandateHash(params.payment);
  const reasons: string[] = [];

  const base: Omit<PolicyDecisionRecord, "verdict" | "consumed"> = {
    mandateId,
    transactionId: claims.transaction_id,
    reasons,
    payee: claims.payee.id.toLowerCase(),
    amount: claims.payment_amount,
    agent: claims.cnf.eip155Address.toLowerCase(),
    intentRef: claims.intent_ref,
    consentRef: params.consentRef,
    timestamp: now,
  };

  const deny = (reason: string, consumed = false): PolicyDecisionRecord => {
    reasons.push(reason);
    const pdr = { ...base, verdict: "deny" as const, consumed };
    params.store.recordDecision(pdr);
    return pdr;
  };

  // 1. Authenticity + mandate chain (signatures, expiry, intent_ref, within budget).
  const chain = await verifyPaymentAgainstIntent({
    payment: params.payment,
    intent: params.intent,
    recover: params.recover,
    now: Math.floor(now / 1000),
  });
  if (!chain.valid) return deny(`mandate_invalid: ${chain.error}`);

  // 2. Context binding — the mandate's payee must be the party actually paid.
  if (base.payee !== params.expectedPayee.toLowerCase()) {
    return deny(`context_binding: mandate payee ${base.payee} != settlement recipient`);
  }

  // 3. Amount — the mandate must authorize at least what is being charged.
  const authorized = parse(claims.payment_amount.amount);
  if (!Number.isFinite(authorized) || authorized < params.expectedAmount) {
    return deny(
      `amount: authorized ${claims.payment_amount.amount} < charged ${params.expectedAmount}`,
    );
  }
  if (params.expectedCurrency && claims.payment_amount.currency !== params.expectedCurrency) {
    return deny(
      `currency: mandate ${claims.payment_amount.currency} != ${params.expectedCurrency}`,
    );
  }

  // 4. Consume-once — claim the mandate LAST, so a failed check above never
  // burns it. A replay loses the claim and is denied.
  const claimed = params.store.claimMandate(mandateId, now);
  if (!claimed) return deny("consume_once: mandate already consumed (replay)", false);

  const pdr: PolicyDecisionRecord = { ...base, verdict: "allow", consumed: true };
  params.store.recordDecision(pdr);
  return pdr;
}

/** In-memory store for tests and for nodes without a marketplace DB. */
export class InMemoryEnforcementStore implements EnforcementStore {
  private readonly consumed = new Set<string>();
  readonly decisions: PolicyDecisionRecord[] = [];

  claimMandate(mandateId: string): boolean {
    if (this.consumed.has(mandateId)) return false;
    this.consumed.add(mandateId);
    return true;
  }
  recordDecision(pdr: PolicyDecisionRecord): void {
    this.decisions.push(pdr);
  }
}

type SqliteDb = import("node:sqlite").DatabaseSync;

/**
 * Sqlite-backed store over the marketplace DB. Tables are created lazily (like
 * x402-verify's consumed-tx ledger). `claimMandate` relies on the PRIMARY KEY
 * for a race-free single claim under concurrent verifications.
 */
export function createSqliteEnforcementStore(db: SqliteDb): EnforcementStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap2_consumed_mandates (
      mandate_id TEXT PRIMARY KEY,
      consumed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ap2_policy_decisions (
      id TEXT PRIMARY KEY,
      mandate_id TEXT NOT NULL,
      transaction_id TEXT,
      verdict TEXT NOT NULL,
      reasons TEXT,
      payee TEXT,
      amount_usdc REAL,
      currency TEXT,
      agent TEXT,
      intent_ref TEXT,
      consumed INTEGER NOT NULL,
      consent_ref TEXT,
      ts INTEGER NOT NULL
    );
  `);
  return {
    claimMandate(mandateId: string, now: number): boolean {
      try {
        db.prepare(`INSERT INTO ap2_consumed_mandates (mandate_id, consumed_at) VALUES (?, ?)`).run(
          mandateId,
          now,
        );
        return true;
      } catch (err) {
        if (err instanceof Error && /UNIQUE|constraint|PRIMARY/i.test(err.message)) return false;
        throw err;
      }
    },
    recordDecision(pdr: PolicyDecisionRecord): void {
      db.prepare(
        `INSERT OR REPLACE INTO ap2_policy_decisions
           (id, mandate_id, transaction_id, verdict, reasons, payee, amount_usdc, currency,
            agent, intent_ref, consumed, consent_ref, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `${pdr.mandateId}:${pdr.timestamp}`,
        pdr.mandateId,
        pdr.transactionId,
        pdr.verdict,
        JSON.stringify(pdr.reasons),
        pdr.payee,
        Number.parseFloat(pdr.amount.amount) || 0,
        pdr.amount.currency,
        pdr.agent,
        pdr.intentRef,
        pdr.consumed ? 1 : 0,
        pdr.consentRef ?? null,
        pdr.timestamp,
      );
    },
  };
}

/** Stable synthetic id for a decision, used when correlating PDRs in logs. */
export function decisionId(pdr: PolicyDecisionRecord): string {
  return (
    "pdr:" +
    createHash("sha256").update(`${pdr.mandateId}:${pdr.timestamp}`).digest("hex").slice(0, 16)
  );
}
