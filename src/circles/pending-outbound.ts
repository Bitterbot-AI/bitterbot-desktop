/**
 * PLAN-36 §5.3 (completed): the server-enforced HUMAN approval queue for agent
 * circle writes.
 *
 * History: the `circles` agent tool's send/ask/log_expense were "two-phase"
 * by prompt convention, then (v37 interim) by a preview-minted token — which
 * still let a prompt-injected agent self-serve preview→confirm with no human
 * anywhere in the loop. This module closes §5.3 for real:
 *
 *   agent write  →  QUEUED here (full params + human-facing preview persisted)
 *   human sees an inline approval card in the Circles UI
 *   approve (circles.outbound.approve) → the SERVER executes the stored params
 *   reject / 60-min expiry → nothing ever leaves the node
 *
 * The agent never receives a token and there is no confirm leg to inject —
 * the approval card is the ONLY path. Resolution is an atomic guarded UPDATE
 * (status='pending'), so racing approvals execute exactly once.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

/** How long a queued write waits for the human before expiring unexecuted. */
export const PENDING_OUTBOUND_TTL_MS = 60 * 60_000;
/** Resolved rows older than this are deleted (bounded audit trail). */
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;

export type PendingOutboundAction = "send" | "ask" | "log_expense";

export type PendingOutbound = {
  id: string;
  circleId: string;
  action: PendingOutboundAction;
  /** The exact params the server will execute on approval. */
  params: Record<string, unknown>;
  /** What the human is shown on the approval card. */
  preview: Record<string, unknown>;
  status: string;
  createdAt: number;
  expiresAt: number;
};

/** Opportunistic housekeeping: expire overdue pendings, prune old resolved. */
export function sweepPendingOutbound(db: DatabaseSync, now: number = Date.now()): void {
  db.prepare(
    `UPDATE circle_pending_outbound SET status = 'expired', resolved_at = ?
      WHERE status = 'pending' AND expires_at < ?`,
  ).run(now, now);
  db.prepare(
    `DELETE FROM circle_pending_outbound
      WHERE status != 'pending' AND COALESCE(resolved_at, expires_at) < ?`,
  ).run(now - PRUNE_AFTER_MS);
}

/** Queue an agent write for human approval. Returns the pending id. */
export function queuePendingOutbound(
  db: DatabaseSync,
  args: {
    circleId: string;
    action: PendingOutboundAction;
    params: Record<string, unknown>;
    preview: Record<string, unknown>;
    now?: number;
  },
): string {
  const now = args.now ?? Date.now();
  sweepPendingOutbound(db, now);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO circle_pending_outbound
       (token, action, params_hash, circle_id, params_json, preview_json,
        status, created_at, expires_at)
     VALUES (?, ?, '', ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    args.action,
    args.circleId,
    JSON.stringify(args.params),
    JSON.stringify(args.preview),
    now,
    now + PENDING_OUTBOUND_TTL_MS,
  );
  return id;
}

function toPending(r: {
  token: string;
  circle_id: string | null;
  action: string;
  params_json: string | null;
  preview_json: string | null;
  status: string;
  created_at: number;
  expires_at: number;
}): PendingOutbound | null {
  if (!r.circle_id || !r.params_json) return null; // legacy v37 token row
  let params: Record<string, unknown>;
  let preview: Record<string, unknown>;
  try {
    params = JSON.parse(r.params_json) as Record<string, unknown>;
    preview = JSON.parse(r.preview_json ?? "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    id: r.token,
    circleId: r.circle_id,
    action: r.action as PendingOutboundAction,
    params,
    preview,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

type Row = Parameters<typeof toPending>[0];

/** Pending (unexpired) agent writes awaiting the human, oldest first. */
export function listPendingOutbound(db: DatabaseSync, circleId?: string): PendingOutbound[] {
  sweepPendingOutbound(db);
  const rows = (circleId
    ? db
        .prepare(
          `SELECT * FROM circle_pending_outbound
              WHERE status = 'pending' AND circle_id = ? ORDER BY created_at ASC`,
        )
        .all(circleId)
    : db
        .prepare(
          `SELECT * FROM circle_pending_outbound
              WHERE status = 'pending' ORDER BY created_at ASC`,
        )
        .all()) as unknown as Row[];
  return rows.map(toPending).filter((p): p is PendingOutbound => p !== null);
}

/**
 * Atomically claim a pending write for resolution. Returns the row (with the
 * stored params to execute) only when THIS call moved it out of 'pending' —
 * a racing second approve/reject gets null and must not execute.
 */
export function claimPendingOutbound(
  db: DatabaseSync,
  id: string,
  resolution: "approved" | "rejected",
  now: number = Date.now(),
): PendingOutbound | null {
  const row = db.prepare(`SELECT * FROM circle_pending_outbound WHERE token = ?`).get(id) as
    | Row
    | undefined;
  if (!row) return null;
  const pending = toPending(row);
  if (!pending || row.expires_at < now) return null;
  const res = db
    .prepare(
      `UPDATE circle_pending_outbound SET status = ?, resolved_at = ?
        WHERE token = ? AND status = 'pending'`,
    )
    .run(resolution, now, id);
  return Number(res.changes) === 1 ? pending : null;
}
