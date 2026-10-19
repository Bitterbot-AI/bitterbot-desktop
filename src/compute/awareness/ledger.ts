/**
 * PLAN-57 §4.6: the compute embedding ledger. One row per routed sub-batch:
 * where it ran, which governance class it carried, under which profile,
 * how long it took and, when it fell back, why. It lives next to the
 * delivery tables so "ledger totals match coordinator receipts" is one
 * query, and the doctor and the weekly Niche summary read it.
 */

import type { DatabaseSync } from "node:sqlite";
import type { GovernanceClass, PoolTrust } from "./egress.js";

export type LedgerRoute = "local" | "pool" | "fallback";

export type ComputeLedgerRow = {
  ts: number;
  route: LedgerRoute;
  poolId: string | null;
  workerId: string | null;
  trust: PoolTrust | null;
  cls: GovernanceClass;
  items: number;
  profileKey: string;
  jobId: string | null;
  durationMs: number;
  /** Set on `fallback` rows: timeout, digest_mismatch, dimension_mismatch, processing_mismatch, count_mismatch, policy_violation, error. */
  reason: string | null;
  receiptHash: string | null;
};

export type ComputeLedgerSummary = {
  since: number;
  batches: number;
  items: number;
  byRoute: Record<LedgerRoute, { batches: number; items: number }>;
  /** Pool rows by class and trust, e.g. "personal@trusted". */
  poolByClassTrust: Record<string, number>;
  fallbacksByReason: Record<string, number>;
  policyViolations: number;
  poolItemsPerSecond: number | null;
  localItemsPerSecond: number | null;
};

/**
 * PLAN-57 §4.8: one row per funding event, refused ones included. A funding
 * writes `pending` before the backend is called and `funded` or `failed`
 * after; a `pending` row with no later row means the process died mid-way.
 */
export type ComputePaymentOutcome = "pending" | "funded" | "failed" | "refused";

export type ComputePaymentRow = {
  ts: number;
  jobId: string;
  quoteHash: string | null;
  amountUsdc: number;
  payee: string | null;
  outcome: ComputePaymentOutcome;
  /** For refused rows: agent_origin, internal_connection, chat_decision, missing_scope, paid_disabled, over_cap, over_daily_cap, in_progress, ledger_unavailable, no_quote, quote_changed, already_funded, unsupported, bad_token:<why>; for failed rows: the error text. */
  reason: string | null;
  /** The review row (approval) this funding came from, when it came from one. */
  reviewId: string | null;
  decidedBy: string | null;
  via: string | null;
  txHash: string | null;
};

export type ComputePaymentSummary = {
  since: number;
  /** Settled events: funded + failed + refused. `pending` rows are counted apart. */
  attempts: number;
  funded: number;
  failed: number;
  refused: number;
  /** Fundings started and not settled (a later row for the same job settles them). */
  pending: number;
  fundedUsdc: number;
  refusalsByReason: Record<string, number>;
  /** Refusals that mean an agent-origin path reached the signer: must be zero. */
  agentOriginRefusals: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compute_payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  quote_hash TEXT,
  amount_usdc REAL NOT NULL,
  payee TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  review_id TEXT,
  decided_by TEXT,
  via TEXT,
  tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_compute_payment_events_ts ON compute_payment_events(ts);
CREATE TABLE IF NOT EXISTS compute_embedding_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  route TEXT NOT NULL,
  pool_id TEXT,
  worker_id TEXT,
  trust TEXT,
  class TEXT NOT NULL,
  items INTEGER NOT NULL,
  profile_key TEXT NOT NULL,
  job_id TEXT,
  duration_ms INTEGER NOT NULL,
  reason TEXT,
  receipt_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_compute_embedding_batches_ts ON compute_embedding_batches(ts);
`;

export class ComputeLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  record(row: ComputeLedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO compute_embedding_batches
           (ts, route, pool_id, worker_id, trust, class, items, profile_key, job_id, duration_ms, reason, receipt_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        row.route,
        row.poolId,
        row.workerId,
        row.trust,
        row.cls,
        row.items,
        row.profileKey,
        row.jobId,
        row.durationMs,
        row.reason,
        row.receiptHash,
      );
  }

  recent(limit = 50): ComputeLedgerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compute_embedding_batches ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, limit))) as unknown as Array<Record<string, unknown>>;
    return rows.map(fromRow);
  }

  summary(sinceMs: number): ComputeLedgerSummary {
    const rows = this.db
      .prepare(`SELECT * FROM compute_embedding_batches WHERE ts >= ?`)
      .all(sinceMs) as unknown as Array<Record<string, unknown>>;
    const out: ComputeLedgerSummary = {
      since: sinceMs,
      batches: 0,
      items: 0,
      byRoute: {
        local: { batches: 0, items: 0 },
        pool: { batches: 0, items: 0 },
        fallback: { batches: 0, items: 0 },
      },
      poolByClassTrust: {},
      fallbacksByReason: {},
      policyViolations: 0,
      poolItemsPerSecond: null,
      localItemsPerSecond: null,
    };
    let poolMs = 0;
    let localMs = 0;
    for (const raw of rows) {
      const r = fromRow(raw);
      out.batches += 1;
      out.items += r.items;
      out.byRoute[r.route].batches += 1;
      out.byRoute[r.route].items += r.items;
      if (r.route === "pool") {
        const k = `${r.cls}@${r.trust ?? "?"}`;
        out.poolByClassTrust[k] = (out.poolByClassTrust[k] ?? 0) + 1;
        poolMs += r.durationMs;
      } else if (r.route === "local") {
        localMs += r.durationMs;
      } else {
        const reason = r.reason ?? "unknown";
        out.fallbacksByReason[reason] = (out.fallbacksByReason[reason] ?? 0) + 1;
        if (reason === "policy_violation") {
          out.policyViolations += 1;
        }
      }
    }
    out.poolItemsPerSecond = poolMs > 0 ? round1((out.byRoute.pool.items * 1000) / poolMs) : null;
    out.localItemsPerSecond =
      localMs > 0 ? round1((out.byRoute.local.items * 1000) / localMs) : null;
    return out;
  }

  prune(olderThanMs: number, now = Date.now()): number {
    const r = this.db
      .prepare(`DELETE FROM compute_embedding_batches WHERE ts < ?`)
      .run(now - olderThanMs);
    return Number(r.changes);
  }

  // ── payments (PLAN-57 §4.8) ──

  recordPayment(row: ComputePaymentRow): void {
    this.db
      .prepare(
        `INSERT INTO compute_payment_events
           (ts, job_id, quote_hash, amount_usdc, payee, outcome, reason, review_id, decided_by, via, tx_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.ts,
        row.jobId,
        row.quoteHash,
        row.amountUsdc,
        row.payee,
        row.outcome,
        row.reason,
        row.reviewId,
        row.decidedBy,
        row.via,
        row.txHash,
      );
  }

  recentPayments(limit = 50): ComputePaymentRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM compute_payment_events ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, limit))) as unknown as Array<Record<string, unknown>>;
    return rows.map(paymentFromRow);
  }

  /** USDC actually funded since `sinceMs`; the daily cap counts this. */
  fundedUsdcSince(sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM compute_payment_events
          WHERE ts >= ? AND outcome = 'funded'`,
      )
      .get(sinceMs) as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /** The newest event for a job, whatever its outcome. */
  latestPaymentFor(jobId: string): ComputePaymentRow | null {
    const row = this.db
      .prepare(`SELECT * FROM compute_payment_events WHERE job_id = ? ORDER BY id DESC LIMIT 1`)
      .get(jobId) as unknown as Record<string, unknown> | undefined;
    return row ? paymentFromRow(row) : null;
  }

  /** A job already funded is never funded twice, whatever the coordinator says. */
  fundedTxFor(jobId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT tx_hash FROM compute_payment_events
          WHERE job_id = ? AND outcome = 'funded' ORDER BY id DESC LIMIT 1`,
      )
      .get(jobId) as unknown as { tx_hash: string | null } | undefined;
    return row?.tx_hash ?? null;
  }

  paymentSummary(sinceMs: number): ComputePaymentSummary {
    const rows = this.db
      .prepare(`SELECT * FROM compute_payment_events WHERE ts >= ?`)
      .all(sinceMs) as unknown as Array<Record<string, unknown>>;
    const out: ComputePaymentSummary = {
      since: sinceMs,
      attempts: 0,
      funded: 0,
      failed: 0,
      refused: 0,
      pending: 0,
      fundedUsdc: 0,
      refusalsByReason: {},
      agentOriginRefusals: 0,
    };
    const settledJobs = new Set<string>();
    const pendingRows: ComputePaymentRow[] = [];
    for (const raw of rows) {
      const r = paymentFromRow(raw);
      if (r.outcome === "pending") {
        pendingRows.push(r);
        continue;
      }
      if (r.outcome !== "refused") {
        settledJobs.add(r.jobId);
      }
      out.attempts += 1;
      if (r.outcome === "funded") {
        out.funded += 1;
        out.fundedUsdc += r.amountUsdc;
      } else if (r.outcome === "failed") {
        out.failed += 1;
      } else {
        out.refused += 1;
        const reason = r.reason ?? "unknown";
        out.refusalsByReason[reason] = (out.refusalsByReason[reason] ?? 0) + 1;
        if (reason === "agent_origin") {
          out.agentOriginRefusals += 1;
        }
      }
    }
    out.pending = pendingRows.filter((r) => !settledJobs.has(r.jobId)).length;
    out.fundedUsdc = Math.round(out.fundedUsdc * 1_000_000) / 1_000_000;
    return out;
  }
}

function paymentFromRow(r: Record<string, unknown>): ComputePaymentRow {
  return {
    ts: Number(r.ts),
    jobId: String(r.job_id),
    quoteHash: (r.quote_hash as string | null) ?? null,
    amountUsdc: Number(r.amount_usdc),
    payee: (r.payee as string | null) ?? null,
    outcome: String(r.outcome) as ComputePaymentOutcome,
    reason: (r.reason as string | null) ?? null,
    reviewId: (r.review_id as string | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    via: (r.via as string | null) ?? null,
    txHash: (r.tx_hash as string | null) ?? null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function fromRow(r: Record<string, unknown>): ComputeLedgerRow {
  return {
    ts: Number(r.ts),
    route: String(r.route) as LedgerRoute,
    poolId: (r.pool_id as string | null) ?? null,
    workerId: (r.worker_id as string | null) ?? null,
    trust: (r.trust as PoolTrust | null) ?? null,
    cls: String(r.class) as GovernanceClass,
    items: Number(r.items),
    profileKey: String(r.profile_key),
    jobId: (r.job_id as string | null) ?? null,
    durationMs: Number(r.duration_ms),
    reason: (r.reason as string | null) ?? null,
    receiptHash: (r.receipt_hash as string | null) ?? null,
  };
}
