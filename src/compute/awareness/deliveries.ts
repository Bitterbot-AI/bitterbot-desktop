/**
 * PLAN-57 §4.4: durable completion delivery.
 *
 * `compute_deliveries` is the source of truth for "has the agent been told
 * about this transition". System events are per session and in memory
 * (persisted a day at most), and nothing reconciles them with the
 * coordinator after a restart; this table does. One row per (job,
 * transition), inserted before the event is enqueued, marked delivered
 * only when a heartbeat turn has drained the session's events, and marked
 * deferred (never dropped) when the wake budget is spent.
 *
 * `compute_job_origins` remembers who started a job and in which session,
 * so completions route to the right place and internal consumers never
 * wake anyone.
 *
 * Default DB: `<state>/compute/deliveries.sqlite` (override with
 * BITTERBOT_COMPUTE_DB). Tests use `:memory:`.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

export type ComputeJobOrigin = "agent" | "owner" | "internal";

export type ComputeOriginRow = {
  jobId: string;
  sessionKey: string | null;
  origin: ComputeJobOrigin;
  createdAt: number;
};

export type ComputeDeliveryRow = {
  jobId: string;
  transition: string;
  sessionKey: string;
  createdAt: number;
  enqueuedAt: number | null;
  deliveredAt: number | null;
  deferredUntil: number | null;
  attempts: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compute_job_origins (
  job_id TEXT PRIMARY KEY,
  session_key TEXT,
  origin TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS compute_deliveries (
  job_id TEXT NOT NULL,
  transition TEXT NOT NULL,
  session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enqueued_at INTEGER,
  delivered_at INTEGER,
  deferred_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, transition)
);
CREATE INDEX IF NOT EXISTS compute_deliveries_pending
  ON compute_deliveries (delivered_at, deferred_until);
`;

export function resolveComputeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BITTERBOT_COMPUTE_DB?.trim();
  if (override) {
    return override;
  }
  return path.join(resolveStateDir(env), "compute", "deliveries.sqlite");
}

export class ComputeDeliveryStore {
  private constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  static open(dbPath: string = resolveComputeDbPath()): ComputeDeliveryStore {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const { DatabaseSync } = requireNodeSqlite();
    return new ComputeDeliveryStore(new DatabaseSync(dbPath));
  }

  static inMemory(): ComputeDeliveryStore {
    return ComputeDeliveryStore.open(":memory:");
  }

  close(): void {
    this.db.close();
  }

  // ── origins ──

  recordOrigin(
    jobId: string,
    origin: ComputeJobOrigin,
    sessionKey: string | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO compute_job_origins (job_id, session_key, origin, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET session_key = excluded.session_key, origin = excluded.origin`,
      )
      .run(jobId, sessionKey, origin, now);
  }

  originOf(jobId: string): ComputeOriginRow | null {
    const row = this.db
      .prepare(
        `SELECT job_id, session_key, origin, created_at FROM compute_job_origins WHERE job_id = ?`,
      )
      .get(jobId) as
      | { job_id: string; session_key: string | null; origin: string; created_at: number }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      jobId: row.job_id,
      sessionKey: row.session_key,
      origin: row.origin as ComputeJobOrigin,
      createdAt: row.created_at,
    };
  }

  internalJobIds(): string[] {
    const rows = this.db
      .prepare(`SELECT job_id FROM compute_job_origins WHERE origin = 'internal'`)
      .all() as unknown as Array<{ job_id: string }>;
    return rows.map((r) => r.job_id);
  }

  /** Forget origins older than `olderThanMs` (jobs long gone from the coordinator). */
  pruneOrigins(olderThanMs: number, now = Date.now()): number {
    const res = this.db
      .prepare(`DELETE FROM compute_job_origins WHERE created_at < ?`)
      .run(now - olderThanMs);
    return Number(res.changes);
  }

  // ── deliveries ──

  /** Idempotent: returns true only the first time this (job, transition) is seen. */
  createDelivery(jobId: string, transition: string, sessionKey: string, now = Date.now()): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO compute_deliveries (job_id, transition, session_key, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(jobId, transition, sessionKey, now);
    return Number(res.changes) === 1;
  }

  markEnqueued(
    jobId: string,
    transition: string,
    opts: { now?: number; deferredUntil?: number | null } = {},
  ): void {
    const now = opts.now ?? Date.now();
    this.db
      .prepare(
        `UPDATE compute_deliveries
         SET enqueued_at = ?, deferred_until = ?, attempts = attempts + 1
         WHERE job_id = ? AND transition = ?`,
      )
      .run(now, opts.deferredUntil ?? null, jobId, transition);
  }

  /** A heartbeat turn drained this session's events: everything enqueued before it is delivered. */
  markDeliveredUpTo(sessionKey: string, drainedAt: number): number {
    const res = this.db
      .prepare(
        `UPDATE compute_deliveries
         SET delivered_at = ?, deferred_until = NULL
         WHERE session_key = ? AND delivered_at IS NULL AND enqueued_at IS NOT NULL AND enqueued_at <= ?`,
      )
      .run(drainedAt, sessionKey, drainedAt);
    return Number(res.changes);
  }

  pending(): ComputeDeliveryRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM compute_deliveries WHERE delivered_at IS NULL ORDER BY created_at`)
        .all() as unknown as RawDelivery[]
    ).map(toRow);
  }

  /** Deferred rows whose hold has expired. */
  dueDeferred(now = Date.now()): ComputeDeliveryRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM compute_deliveries
           WHERE delivered_at IS NULL AND deferred_until IS NOT NULL AND deferred_until <= ?
           ORDER BY created_at`,
        )
        .all(now) as unknown as RawDelivery[]
    ).map(toRow);
  }

  deferredCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM compute_deliveries WHERE delivered_at IS NULL AND deferred_until IS NOT NULL`,
      )
      .get() as { n: number };
    return Number(row.n);
  }

  hasDelivery(jobId: string, transition: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM compute_deliveries WHERE job_id = ? AND transition = ?`)
      .get(jobId, transition);
    return Boolean(row);
  }

  pruneDelivered(olderThanMs: number, now = Date.now()): number {
    const res = this.db
      .prepare(`DELETE FROM compute_deliveries WHERE delivered_at IS NOT NULL AND delivered_at < ?`)
      .run(now - olderThanMs);
    return Number(res.changes);
  }
}

type RawDelivery = {
  job_id: string;
  transition: string;
  session_key: string;
  created_at: number;
  enqueued_at: number | null;
  delivered_at: number | null;
  deferred_until: number | null;
  attempts: number;
};

function toRow(r: RawDelivery): ComputeDeliveryRow {
  return {
    jobId: r.job_id,
    transition: r.transition,
    sessionKey: r.session_key,
    createdAt: r.created_at,
    enqueuedAt: r.enqueued_at,
    deliveredAt: r.delivered_at,
    deferredUntil: r.deferred_until,
    attempts: r.attempts,
  };
}
