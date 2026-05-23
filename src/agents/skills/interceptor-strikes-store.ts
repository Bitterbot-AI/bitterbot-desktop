/**
 * PLAN-20 follow-up: SQLite-backed persistence for the 3-strikes
 * auto-disable counter. Survives gateway restarts so a noisy interceptor
 * stays disabled until an operator clears it.
 *
 * Keyed on interceptor id. Lazy-init via the autoboot DB handle.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agents/skills/interceptor-strikes");

export interface StrikesRow {
  interceptorId: string;
  strikes: number;
  disabled: boolean;
  lastFailureTs: number | null;
  lastFailureReason: string | null;
}

interface RawRow {
  interceptor_id: string;
  strikes: number;
  disabled: number;
  last_failure_ts: number | null;
  last_failure_reason: string | null;
}

export interface InterceptorStrikesStore {
  loadDisabled(): string[];
  recordStrike(interceptorId: string, reason: string): { strikes: number; disabled: boolean };
  clear(interceptorId: string): void;
  list(): StrikesRow[];
}

export function createSqliteInterceptorStrikesStore(db: DatabaseSync): InterceptorStrikesStore {
  const loadDisabledStmt = db.prepare(
    `SELECT interceptor_id FROM interceptor_strikes WHERE disabled = 1`,
  );
  const upsertStmt = db.prepare(
    `INSERT INTO interceptor_strikes (interceptor_id, strikes, disabled, last_failure_ts, last_failure_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(interceptor_id) DO UPDATE SET
       strikes = excluded.strikes,
       disabled = excluded.disabled,
       last_failure_ts = excluded.last_failure_ts,
       last_failure_reason = excluded.last_failure_reason`,
  );
  const readStmt = db.prepare(
    `SELECT interceptor_id, strikes, disabled, last_failure_ts, last_failure_reason
       FROM interceptor_strikes WHERE interceptor_id = ?`,
  );
  const deleteStmt = db.prepare(`DELETE FROM interceptor_strikes WHERE interceptor_id = ?`);
  const listStmt = db.prepare(
    `SELECT interceptor_id, strikes, disabled, last_failure_ts, last_failure_reason
       FROM interceptor_strikes ORDER BY interceptor_id`,
  );

  return {
    loadDisabled(): string[] {
      try {
        const rows = loadDisabledStmt.all() as unknown as Array<{ interceptor_id: string }>;
        return rows.map((r) => r.interceptor_id);
      } catch (err) {
        log.debug(`loadDisabled failed: ${String(err)}`);
        return [];
      }
    },

    recordStrike(interceptorId, reason): { strikes: number; disabled: boolean } {
      try {
        const existing = readStmt.get(interceptorId) as RawRow | undefined;
        const strikes = (existing?.strikes ?? 0) + 1;
        const disabled = strikes >= 3 ? 1 : 0;
        upsertStmt.run(interceptorId, strikes, disabled, Date.now(), reason.slice(0, 240));
        return { strikes, disabled: disabled === 1 };
      } catch (err) {
        log.debug(`recordStrike failed for id=${interceptorId}: ${String(err)}`);
        return { strikes: 0, disabled: false };
      }
    },

    clear(interceptorId): void {
      try {
        deleteStmt.run(interceptorId);
      } catch (err) {
        log.debug(`clear failed for id=${interceptorId}: ${String(err)}`);
      }
    },

    list(): StrikesRow[] {
      try {
        const rows = listStmt.all() as unknown as RawRow[];
        return rows.map((r) => ({
          interceptorId: r.interceptor_id,
          strikes: r.strikes,
          disabled: r.disabled === 1,
          lastFailureTs: r.last_failure_ts,
          lastFailureReason: r.last_failure_reason,
        }));
      } catch (err) {
        log.debug(`list failed: ${String(err)}`);
        return [];
      }
    },
  };
}

let registered: InterceptorStrikesStore | null = null;

export function setInterceptorStrikesStore(store: InterceptorStrikesStore | null): void {
  registered = store;
}

export function getInterceptorStrikesStore(): InterceptorStrikesStore | null {
  return registered;
}
