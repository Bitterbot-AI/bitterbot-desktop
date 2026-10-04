/**
 * Where reviewed actions live (PLAN-53 B2).
 *
 * One row per action the agent wanted to take that needed a person's decision:
 * what it was, who decided, what happened. The same table is the decision log
 * the Activity view reads, so there is one record of "what my agent did on my
 * behalf" rather than five.
 *
 * Its own SQLite file (`~/.bitterbot/review.sqlite`), like tasks.sqlite: this
 * must not depend on the memory database, which has been rebuilt from scratch
 * before, and it holds nothing the memory system needs.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import { assertNotRealStateUnderTest } from "../infra/test-state-guard.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type { ReviewClass } from "./classify.js";

/**
 * What kind of request a row is. "spend" and "publish" are approvals of a held
 * tool call; "handoff" is the agent asking the owner to take over the browser.
 */
export type ReviewKind = ReviewClass | "handoff";

export type ReviewStatus = "pending" | "approved" | "denied" | "expired" | "executed" | "failed";

export type ReviewAction = {
  id: string;
  createdAt: number;
  expiresAt: number;
  status: ReviewStatus;
  cls: ReviewKind;
  tool: string;
  params: unknown;
  /** Canonical hash of (tool, params); one pending row per fingerprint and session. */
  fingerprint: string;
  preview: string;
  sessionKey: string | null;
  agentId: string | null;
  runId: string | null;
  decidedAt: number | null;
  decidedBy: string | null;
  decidedVia: string | null;
  note: string | null;
  /** What the execution produced, for the person and the session. */
  resultSummary: string | null;
  executedAt: number | null;
};

type Row = {
  id: string;
  created_at: number;
  expires_at: number;
  status: ReviewStatus;
  cls: ReviewKind;
  tool: string;
  params_json: string;
  fingerprint: string;
  preview: string;
  session_key: string | null;
  agent_id: string | null;
  run_id: string | null;
  decided_at: number | null;
  decided_by: string | null;
  decided_via: string | null;
  note: string | null;
  result_summary: string | null;
  executed_at: number | null;
};

/** A request nobody decides on is dropped after this long. */
export const REVIEW_DEFAULT_TTL_MS = 24 * 60 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_actions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  cls TEXT NOT NULL,
  tool TEXT NOT NULL,
  params_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  preview TEXT NOT NULL,
  session_key TEXT,
  agent_id TEXT,
  run_id TEXT,
  decided_at INTEGER,
  decided_by TEXT,
  decided_via TEXT,
  note TEXT,
  result_summary TEXT,
  executed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_actions_status ON review_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_review_actions_fingerprint ON review_actions(fingerprint, session_key, status);
`;

function toAction(row: Row): ReviewAction {
  let params: unknown = null;
  try {
    params = JSON.parse(row.params_json);
  } catch {
    params = null;
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    cls: row.cls,
    tool: row.tool,
    params,
    fingerprint: row.fingerprint,
    preview: row.preview,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    runId: row.run_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedVia: row.decided_via,
    note: row.note,
    resultSummary: row.result_summary,
    executedAt: row.executed_at,
  };
}

export class ReviewStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
  }

  static open(dbPath?: string, now: () => number = Date.now): ReviewStore {
    const resolved = dbPath ?? path.join(resolveStateDir(), "review.sqlite");
    assertNotRealStateUnderTest(resolved);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolved);
    try {
      db.prepare("PRAGMA journal_mode=WAL").get();
    } catch {
      // older SQLite: default journal
    }
    return new ReviewStore(db, now);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Create a pending row, or return the pending row that already exists for
   * the same call in the same session. The agent re-asking is not a new request.
   */
  request(input: {
    id: string;
    cls: ReviewKind;
    tool: string;
    params: unknown;
    fingerprint: string;
    preview: string;
    sessionKey?: string | null;
    agentId?: string | null;
    runId?: string | null;
    ttlMs?: number;
  }): { action: ReviewAction; created: boolean } {
    this.expireDue();
    const existing = this.db
      .prepare(
        `SELECT * FROM review_actions
          WHERE fingerprint = ? AND status = 'pending' AND session_key IS ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.fingerprint, input.sessionKey ?? null) as unknown as Row | undefined;
    if (existing) {
      return { action: toAction(existing), created: false };
    }
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO review_actions
           (id, created_at, expires_at, status, cls, tool, params_json, fingerprint, preview,
            session_key, agent_id, run_id)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        at,
        at + (input.ttlMs ?? REVIEW_DEFAULT_TTL_MS),
        input.cls,
        input.tool,
        JSON.stringify(input.params ?? null),
        input.fingerprint,
        input.preview,
        input.sessionKey ?? null,
        input.agentId ?? null,
        input.runId ?? null,
      );
    return { action: this.get(input.id) as ReviewAction, created: true };
  }

  get(id: string): ReviewAction | null {
    const row = this.db.prepare(`SELECT * FROM review_actions WHERE id = ?`).get(id) as unknown as
      | Row
      | undefined;
    return row ? toAction(row) : null;
  }

  /**
   * Record the decision. Returns false if the row was not pending any more:
   * two people, or two surfaces, cannot both resolve the same request.
   */
  decide(
    id: string,
    decision: "approved" | "denied",
    by: { decidedBy: string; decidedVia: string; note?: string },
  ): boolean {
    this.expireDue();
    const result = this.db
      .prepare(
        `UPDATE review_actions
            SET status = ?, decided_at = ?, decided_by = ?, decided_via = ?, note = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, this.now(), by.decidedBy, by.decidedVia, by.note ?? null, id);
    return Number(result.changes) === 1;
  }

  /** The approved action ran (or did not). */
  markExecution(id: string, outcome: { ok: boolean; summary: string }): void {
    this.db
      .prepare(
        `UPDATE review_actions SET status = ?, result_summary = ?, executed_at = ?
          WHERE id = ? AND status = 'approved'`,
      )
      .run(outcome.ok ? "executed" : "failed", outcome.summary.slice(0, 4000), this.now(), id);
  }

  list(opts?: { status?: ReviewStatus | "all"; limit?: number }): ReviewAction[] {
    this.expireDue();
    const limit = Math.min(500, Math.max(1, opts?.limit ?? 100));
    const status = opts?.status ?? "pending";
    const rows =
      status === "all"
        ? (this.db
            .prepare(`SELECT * FROM review_actions ORDER BY created_at DESC LIMIT ?`)
            .all(limit) as unknown as Row[])
        : (this.db
            .prepare(
              `SELECT * FROM review_actions WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
            )
            .all(status, limit) as unknown as Row[]);
    return rows.map(toAction);
  }

  pendingCount(): number {
    this.expireDue();
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM review_actions WHERE status = 'pending'`)
        .get() as { c: number }
    ).c;
  }

  /** Close one pending request that nobody answered in time. */
  expire(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE review_actions SET status = 'expired', decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(this.now(), id);
    return Number(result.changes) === 1;
  }

  /** Pending requests past their deadline are not approvals waiting to happen. */
  expireDue(): number {
    const result = this.db
      .prepare(
        `UPDATE review_actions SET status = 'expired', decided_at = ?
          WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(this.now(), this.now());
    return Number(result.changes);
  }
}
