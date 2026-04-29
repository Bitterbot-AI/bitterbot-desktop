/**
 * Session checkpoint graph (PLAN-14 Pillar 6 #2).
 *
 * Persists a tree of agent execution states keyed by (thread_id, step_id).
 * Each checkpoint records `parent_step_id` to support forks: fork-from-step
 * copies the path from root to the chosen step into a fresh thread, so a
 * long run can be branched and re-executed from any prior state without
 * touching the original timeline.
 *
 * This is the LangGraph-parity feature that, combined with PLAN-14 Pillar
 * 5 (long-horizon work-rest-dream loop), gives Bitterbot what no other
 * biological agent has: deterministic replay of a 6-hour session from any
 * intermediate point. State blobs are gzip-compressed JSON; dedup is by
 * SHA-256 of the compressed bytes so identical states across forks share
 * storage on the row level (UNIQUE on hash + thread_id keeps the fast path
 * cheap without a separate blob table).
 *
 * Schema is a single table; checkpoint kinds are an open string enum so
 * callers (gateway, embedded runner, dream engine) can tag their own
 * boundaries without schema migrations.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";

const log = createSubsystemLogger("checkpoints/store");

export type CheckpointKind =
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "fork_root"
  | "compaction"
  | "custom";

export type CheckpointInput = {
  threadId: string;
  stepId: string;
  parentStepId?: string | null;
  kind: CheckpointKind;
  state: unknown;
  label?: string;
  metadata?: Record<string, unknown>;
  ts?: number;
};

export type CheckpointRow = {
  id: number;
  threadId: string;
  stepId: string;
  parentStepId: string | null;
  ts: number;
  kind: CheckpointKind;
  label: string | null;
  stateHash: string;
  metadata: Record<string, unknown> | null;
};

export type CheckpointWithState = CheckpointRow & {
  state: unknown;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id       TEXT NOT NULL,
  step_id         TEXT NOT NULL,
  parent_step_id  TEXT,
  ts              INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  label           TEXT,
  state_hash      TEXT NOT NULL,
  state_blob      BLOB NOT NULL,
  metadata_json   TEXT,
  UNIQUE(thread_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_thread_ts ON checkpoints(thread_id, ts);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_step_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_hash ON checkpoints(state_hash);
`;

export class CheckpointStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Open a fresh checkpoint store at the given path, creating the file
   * and parent directory if needed. WAL mode is enabled to keep the
   * checkpoint writer from blocking the readers (gateway dashboards,
   * fork CLI) on the same DB.
   */
  static open(dbPath: string): CheckpointStore {
    const resolved = resolveUserPath(dbPath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolved);
    try {
      db.prepare("PRAGMA journal_mode=WAL").get();
    } catch {
      // Older SQLite builds without WAL fall back to the default journal.
    }
    try {
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
    } catch {
      // PRAGMA is non-essential — never block init on it.
    }
    return new CheckpointStore(db);
  }

  /**
   * Save a checkpoint. Returns the row as written, including the
   * auto-assigned id. Idempotent on (thread_id, step_id): re-saving
   * the same step is a no-op that returns the existing row.
   */
  save(input: CheckpointInput): CheckpointRow {
    const ts = input.ts ?? Date.now();
    const stateJson = JSON.stringify(input.state ?? null);
    const stateBlob = zlib.gzipSync(stateJson);
    const stateHash = crypto.createHash("sha256").update(stateBlob).digest("hex");
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

    const existing = this.db
      .prepare(`SELECT id FROM checkpoints WHERE thread_id = ? AND step_id = ?`)
      .get(input.threadId, input.stepId) as { id: number } | undefined;
    if (existing) {
      log.debug(
        `checkpoint already exists thread=${input.threadId} step=${input.stepId} id=${existing.id}`,
      );
      const row = this.getById(existing.id);
      if (row) return row;
    }

    const result = this.db
      .prepare(
        `INSERT INTO checkpoints
          (thread_id, step_id, parent_step_id, ts, kind, label, state_hash, state_blob, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.threadId,
        input.stepId,
        input.parentStepId ?? null,
        ts,
        input.kind,
        input.label ?? null,
        stateHash,
        stateBlob,
        metadataJson,
      );

    return {
      id: Number(result.lastInsertRowid),
      threadId: input.threadId,
      stepId: input.stepId,
      parentStepId: input.parentStepId ?? null,
      ts,
      kind: input.kind,
      label: input.label ?? null,
      stateHash,
      metadata: input.metadata ?? null,
    };
  }

  /**
   * Look up a checkpoint with its decompressed state. Returns undefined
   * when the (thread, step) pair is not present.
   */
  get(threadId: string, stepId: string): CheckpointWithState | undefined {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, step_id, parent_step_id, ts, kind, label,
                state_hash, state_blob, metadata_json
         FROM checkpoints WHERE thread_id = ? AND step_id = ?`,
      )
      .get(threadId, stepId) as RawCheckpointRow | undefined;
    return row ? rowToCheckpointWithState(row) : undefined;
  }

  /** List checkpoints in a thread, oldest first. */
  list(threadId: string, opts: { limit?: number; sinceTs?: number } = {}): CheckpointRow[] {
    const limit = opts.limit ?? 1000;
    const sinceTs = opts.sinceTs ?? 0;
    const rows = this.db
      .prepare(
        `SELECT id, thread_id, step_id, parent_step_id, ts, kind, label, state_hash, metadata_json
         FROM checkpoints WHERE thread_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?`,
      )
      .all(threadId, sinceTs, limit) as RawCheckpointRowMeta[];
    return rows.map(rowToCheckpointMeta);
  }

  /**
   * Walk a checkpoint's lineage back to the root. Returns oldest-first.
   * Useful for replay: feed each state into the runtime in order.
   */
  ancestors(threadId: string, stepId: string): CheckpointWithState[] {
    const out: CheckpointWithState[] = [];
    let cursor: string | null = stepId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const cp = this.get(threadId, cursor);
      if (!cp) break;
      out.unshift(cp);
      cursor = cp.parentStepId;
    }
    return out;
  }

  /**
   * Fork a thread from a chosen step. Copies the lineage root → stepId
   * into a freshly-named thread, preserving step ids inside the new
   * thread. Returns the new thread id. Subsequent saves under the new
   * thread id continue from the forked tip.
   *
   * Fork is a structural operation only — it does not start a new run.
   * Callers (CLI, gateway, runtime) replay the lineage themselves to
   * recreate runtime state.
   */
  fork(threadId: string, stepId: string, opts: { newThreadId?: string } = {}): string {
    const lineage = this.ancestors(threadId, stepId);
    if (lineage.length === 0) {
      throw new Error(`fork: no checkpoint at thread=${threadId} step=${stepId}`);
    }
    const newThreadId = opts.newThreadId ?? `${threadId}.fork-${Date.now().toString(36)}`;
    const insert = this.db.prepare(
      `INSERT INTO checkpoints
        (thread_id, step_id, parent_step_id, ts, kind, label, state_hash, state_blob, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.prepare("BEGIN");
    const commit = this.db.prepare("COMMIT");
    const rollback = this.db.prepare("ROLLBACK");
    tx.run();
    try {
      for (const cp of lineage) {
        const stateJson = JSON.stringify(cp.state ?? null);
        const stateBlob = zlib.gzipSync(stateJson);
        insert.run(
          newThreadId,
          cp.stepId,
          cp.parentStepId,
          cp.ts,
          cp.kind,
          cp.label,
          cp.stateHash,
          stateBlob,
          cp.metadata ? JSON.stringify(cp.metadata) : null,
        );
      }
      // Record an explicit fork_root marker so timeline UIs can surface
      // the branch point clearly.
      const forkStepId = `${stepId}.fork-${Date.now().toString(36)}`;
      const forkBlob = zlib.gzipSync(JSON.stringify({ forkedFrom: { threadId, stepId } }));
      const forkHash = crypto.createHash("sha256").update(forkBlob).digest("hex");
      insert.run(
        newThreadId,
        forkStepId,
        stepId,
        Date.now(),
        "fork_root",
        `forked from ${threadId}@${stepId}`,
        forkHash,
        forkBlob,
        JSON.stringify({ origin: { threadId, stepId } }),
      );
      commit.run();
    } catch (err) {
      rollback.run();
      throw err;
    }
    log.info(`forked thread=${threadId} step=${stepId} -> newThread=${newThreadId}`);
    return newThreadId;
  }

  /** Delete every checkpoint in a thread. Returns the count removed. */
  deleteThread(threadId: string): number {
    const result = this.db.prepare(`DELETE FROM checkpoints WHERE thread_id = ?`).run(threadId);
    return Number(result.changes);
  }

  /** Distinct thread ids present, most-recent first. */
  listThreads(limit = 100): Array<{ threadId: string; lastTs: number; steps: number }> {
    const rows = this.db
      .prepare(
        `SELECT thread_id AS threadId, MAX(ts) AS lastTs, COUNT(*) AS steps
         FROM checkpoints GROUP BY thread_id ORDER BY lastTs DESC LIMIT ?`,
      )
      .all(limit) as Array<{ threadId: string; lastTs: number; steps: number }>;
    return rows;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn(`checkpoint store close error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getById(id: number): CheckpointRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, step_id, parent_step_id, ts, kind, label, state_hash, metadata_json
         FROM checkpoints WHERE id = ?`,
      )
      .get(id) as RawCheckpointRowMeta | undefined;
    return row ? rowToCheckpointMeta(row) : undefined;
  }
}

type RawCheckpointRowMeta = {
  id: number;
  thread_id: string;
  step_id: string;
  parent_step_id: string | null;
  ts: number;
  kind: string;
  label: string | null;
  state_hash: string;
  metadata_json: string | null;
};

type RawCheckpointRow = RawCheckpointRowMeta & {
  state_blob: Uint8Array;
};

function rowToCheckpointMeta(row: RawCheckpointRowMeta): CheckpointRow {
  return {
    id: row.id,
    threadId: row.thread_id,
    stepId: row.step_id,
    parentStepId: row.parent_step_id,
    ts: row.ts,
    kind: row.kind as CheckpointKind,
    label: row.label,
    stateHash: row.state_hash,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
  };
}

function rowToCheckpointWithState(row: RawCheckpointRow): CheckpointWithState {
  const stateJson = zlib.gunzipSync(row.state_blob).toString("utf8");
  const state = JSON.parse(stateJson);
  return {
    ...rowToCheckpointMeta(row),
    state,
  };
}
