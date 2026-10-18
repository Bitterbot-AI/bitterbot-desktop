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

const SCHEMA = `
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
