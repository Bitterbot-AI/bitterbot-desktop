/**
 * Sqlite-backed store for spend grants (PLAN-48 Phase 0). Persists signed grants
 * and resolves the active grant covering a proposed spend, tracking per-period
 * usage via SpendPermissionPolicy. Verify-on-write and verify-on-read (a grant is
 * re-checked against its signature whenever it is resolved, so a row edited in the
 * DB directly is rejected). No payment-path change lands in this phase — this is
 * the substrate the emission gate (Phase 1) and escalation (Phase 2) build on.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CirclePubkey, SignEd25519Fn, VerifyEd25519Fn } from "../ap2/consent.js";
import { shortId } from "../ap2/ed25519.js";
import { SpendPermissionPolicy } from "../wallet/spend-permission.js";
import {
  buildSpendGrant,
  grantCovers,
  grantSpecificity,
  usdc,
  verifySpendGrant,
  type SpendGrant,
  type SpendGrantClaims,
} from "./spend-grant.js";

export interface StoredGrant {
  grant: SpendGrant;
  revokedAt: number | null;
}

export interface GrantResolution {
  grant: SpendGrant | null;
  reason?: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface SpendApproval {
  approvalId: string;
  payee: string;
  amountUsd: number;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt: number | null;
  grantId: string | null;
  /**
   * How a human confirmed the approval (PLAN-48 Phase 2 step-up). Recorded for
   * the audit trail: "passkey" (a platform biometric/passkey ceremony passed in
   * the Control UI), "typed" (typed-confirmation fallback), or null (one-tap /
   * below the step-up threshold). Advisory today — the ceremony is client-side;
   * server-side WebAuthn assertion verification is a tracked fast-follow.
   */
  confirmation: string | null;
}

function amountUsd(a: { amount: string }): number {
  const n = Number.parseFloat(a.amount);
  return Number.isFinite(n) ? n : 0;
}

export class SpendGrantStore {
  /**
   * @param db          the marketplace sqlite handle.
   * @param onEscalation optional side-effect fired ONCE when `requestApproval`
   *        inserts a NEW pending approval (never on a reused one). Callers wire
   *        the escalation notifier here so a raised approval reaches the
   *        operator; best-effort, and a throw is swallowed so it never breaks
   *        the (already fail-safe) escalation.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly onEscalation?: (approval: SpendApproval) => void,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spend_grants (
        grant_id TEXT PRIMARY KEY,
        owner_pubkey TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        exp INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS spend_grant_usage (
        id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spend_grant_usage_grant ON spend_grant_usage (grant_id);
      CREATE TABLE IF NOT EXISTS spend_grant_approvals (
        approval_id TEXT PRIMARY KEY,
        payee TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        grant_id TEXT
      );
    `);
    // Additive column for the step-up confirmation method (PLAN-48 Phase 2).
    // CREATE TABLE IF NOT EXISTS above won't add it to a pre-existing table, so
    // apply it defensively; ALTER throws if the column already exists.
    try {
      this.db.exec(`ALTER TABLE spend_grant_approvals ADD COLUMN confirmation TEXT`);
    } catch {
      // column already present
    }
  }

  /** Persist a grant after verifying its signature. Upsert by grant_id (idempotent). */
  setGrant(grant: SpendGrant, verifyEd25519: VerifyEd25519Fn): void {
    const v = verifySpendGrant(grant, verifyEd25519);
    if (!v.ok) throw new Error(`refusing to store invalid grant: ${v.reason}`);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO spend_grants (grant_id, owner_pubkey, claims_json, signature, exp, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(grant_id) DO UPDATE SET
           claims_json = excluded.claims_json, signature = excluded.signature, exp = excluded.exp`,
      )
      .run(
        grant.claims.grant_id,
        grant.claims.owner_pubkey,
        JSON.stringify(grant.claims),
        grant.signature,
        grant.claims.exp,
        now,
      );
  }

  /** Mark a grant revoked. Real-time: it authorizes no further spend on the next resolve. */
  revokeGrant(grantId: string, now: number = Date.now()): void {
    this.db
      .prepare(`UPDATE spend_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
      .run(now, grantId);
  }

  /** Record a settled spend against a grant so it counts toward the period allowance. */
  recordUsage(grantId: string, usd: number, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO spend_grant_usage (id, grant_id, amount_usd, at_ms) VALUES (?, ?, ?, ?)`,
      )
      .run(`${grantId}:${now}:${Math.random().toString(16).slice(2, 8)}`, grantId, usd, now);
  }

  private row(grantId: string): StoredGrant | null {
    const r = this.db
      .prepare(`SELECT claims_json, signature, revoked_at FROM spend_grants WHERE grant_id = ?`)
      .get(grantId) as unknown as
      | { claims_json: string; signature: string; revoked_at: number | null }
      | undefined;
    if (!r) return null;
    const claims = JSON.parse(r.claims_json) as SpendGrantClaims;
    return { grant: { claims, signature: r.signature }, revokedAt: r.revoked_at };
  }

  /** All grants (optionally including revoked/expired), newest-created first. */
  listGrants(opts?: { includeInactive?: boolean; now?: number }): StoredGrant[] {
    const now = opts?.now ?? Date.now();
    const rows = this.db
      .prepare(`SELECT grant_id, revoked_at, exp FROM spend_grants ORDER BY created_at DESC`)
      .all() as unknown as Array<{ grant_id: string; revoked_at: number | null; exp: number }>;
    const out: StoredGrant[] = [];
    for (const r of rows) {
      const active = r.revoked_at === null && r.exp * 1000 > now;
      if (!opts?.includeInactive && !active) continue;
      const s = this.row(r.grant_id);
      if (s) out.push(s);
    }
    return out;
  }

  /** Spend recorded against a grant in the period containing `now` (unix ms). */
  private consumedInPeriodUsd(grant: SpendGrant, nowMs: number): number {
    const usage = this.db
      .prepare(`SELECT amount_usd, at_ms FROM spend_grant_usage WHERE grant_id = ?`)
      .all(grant.claims.grant_id) as unknown as Array<{ amount_usd: number; at_ms: number }>;
    const policy = new SpendPermissionPolicy(
      {
        allowanceUsd: amountUsd(grant.claims.allowance),
        periodSeconds: grant.claims.period_seconds,
      },
      usage.map((u) => ({ amountUsd: u.amount_usd, atMs: u.at_ms })),
    );
    return policy.consumedUsd(nowMs);
  }

  /**
   * Find the active grant that covers a proposed spend, most-payee-specific first.
   * Re-verifies each candidate's signature (defends a directly-edited DB row) and
   * skips revoked/expired grants. Returns the grant, or null with the last reason
   * a candidate failed (so the caller can explain why a spend must escalate).
   */
  activeGrantFor(params: {
    payee: string;
    amountUsd: number;
    verifyEd25519: VerifyEd25519Fn;
    now?: number; // unix ms
  }): GrantResolution {
    const nowMs = params.now ?? Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const candidates = this.listGrants({ now: nowMs })
      .map((s) => s.grant)
      .filter((g) => verifySpendGrant(g, params.verifyEd25519).ok)
      .toSorted((a, b) => grantSpecificity(b, params.payee) - grantSpecificity(a, params.payee));

    let reason = "no active grant covers this spend";
    for (const grant of candidates) {
      const cov = grantCovers(grant, {
        payee: params.payee,
        amountUsd: params.amountUsd,
        consumedInPeriodUsd: this.consumedInPeriodUsd(grant, nowMs),
        now: nowSec,
      });
      if (cov.ok) return { grant };
      reason = cov.reason ?? reason;
    }
    return { grant: null, reason };
  }

  // --- Escalation: out-of-scope spend -> human approval -> one-time grant ---

  /**
   * Raise (or reuse) a pending approval request for an out-of-scope spend. The
   * human-facing delivery (push, one-tap UI) consumes these; approving one mints
   * a one-time grant scoped to exactly this spend. Idempotent per (payee, amount):
   * a duplicate request returns the existing pending row rather than piling up.
   */
  requestApproval(params: {
    payee: string;
    amountUsd: number;
    reason?: string;
    now?: number;
  }): SpendApproval {
    const now = params.now ?? Date.now();
    const payee = params.payee.toLowerCase();
    const existing = this.db
      .prepare(
        `SELECT approval_id FROM spend_grant_approvals
          WHERE payee = ? AND amount_usd = ? AND status = 'pending' LIMIT 1`,
      )
      .get(payee, params.amountUsd) as unknown as { approval_id: string } | undefined;
    if (existing) return this.getApproval(existing.approval_id)!;

    const approvalId = shortId("approval", `${payee}:${params.amountUsd}:${now}`);
    this.db
      .prepare(
        `INSERT INTO spend_grant_approvals
           (approval_id, payee, amount_usd, reason, status, created_at, resolved_at, grant_id)
         VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
      )
      .run(approvalId, payee, params.amountUsd, params.reason ?? "out-of-scope spend", now);
    const approval = this.getApproval(approvalId)!;
    // Deliver only on a NEW approval (the reused-pending branch above returned
    // early), so a retry loop escalating the same spend does not re-notify.
    if (this.onEscalation) {
      try {
        this.onEscalation(approval);
      } catch {
        // best-effort delivery: never let it break the fail-safe escalation
      }
    }
    return approval;
  }

  getApproval(approvalId: string): SpendApproval | null {
    const r = this.db
      .prepare(
        `SELECT approval_id, payee, amount_usd, reason, status, created_at, resolved_at, grant_id, confirmation
           FROM spend_grant_approvals WHERE approval_id = ?`,
      )
      .get(approvalId) as unknown as
      | {
          approval_id: string;
          payee: string;
          amount_usd: number;
          reason: string;
          status: ApprovalStatus;
          created_at: number;
          resolved_at: number | null;
          grant_id: string | null;
          confirmation: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      approvalId: r.approval_id,
      payee: r.payee,
      amountUsd: r.amount_usd,
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      grantId: r.grant_id,
      confirmation: r.confirmation ?? null,
    };
  }

  listApprovals(status?: ApprovalStatus): SpendApproval[] {
    const rows = (status
      ? this.db
          .prepare(
            `SELECT approval_id FROM spend_grant_approvals WHERE status = ? ORDER BY created_at DESC`,
          )
          .all(status)
      : this.db
          .prepare(`SELECT approval_id FROM spend_grant_approvals ORDER BY created_at DESC`)
          .all()) as unknown as Array<{ approval_id: string }>;
    return rows
      .map((r) => this.getApproval(r.approval_id))
      .filter((a): a is SpendApproval => a !== null);
  }

  /**
   * Approve a pending request: mint a one-time grant (this payee only, allowance
   * and per-tx = the requested amount, short TTL) signed by the owner key, store
   * it, and mark the approval resolved. The next `activeGrantFor` for that spend
   * then succeeds. Returns the minted grant. Errors if the request is not pending.
   */
  approve(
    approvalId: string,
    signer: { ownerPubkey: CirclePubkey; signOwner: SignEd25519Fn; verifyEd25519: VerifyEd25519Fn },
    opts?: { ttlMs?: number; now?: number; confirmation?: string },
  ): SpendGrant {
    const appr = this.getApproval(approvalId);
    if (!appr) throw new Error(`approval ${approvalId} not found`);
    if (appr.status !== "pending") throw new Error(`approval ${approvalId} already ${appr.status}`);
    const now = opts?.now ?? Date.now();
    const amount = usdc(appr.amountUsd);
    const grant = buildSpendGrant({
      ownerPubkey: signer.ownerPubkey,
      scope: { allowed_payees: [appr.payee], categories: ["one-time-approval"] },
      allowance: amount,
      periodSeconds: 24 * 60 * 60,
      perTxMax: amount,
      ttlMs: opts?.ttlMs ?? 10 * 60 * 1000, // short-lived: this spend, soon
      signOwner: signer.signOwner,
      now,
    });
    this.setGrant(grant, signer.verifyEd25519);
    this.db
      .prepare(
        `UPDATE spend_grant_approvals SET status = 'approved', resolved_at = ?, grant_id = ?, confirmation = ?
          WHERE approval_id = ?`,
      )
      .run(now, grant.claims.grant_id, opts?.confirmation ?? null, approvalId);
    return grant;
  }

  /** Deny a pending approval (spends nothing). */
  deny(approvalId: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE spend_grant_approvals SET status = 'denied', resolved_at = ?
          WHERE approval_id = ? AND status = 'pending'`,
      )
      .run(now, approvalId);
  }
}
