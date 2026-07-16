/**
 * PLAN-36 §4 (mailbox-mediated join): the INVITEE's record of a join that is
 * riding the inviter's mailbox because a direct dial was impossible (no
 * reachable a2a URL) or failed (inviter offline).
 *
 * The invitee seals its signed `join` envelope into the inviter's mailbox, then
 * waits for a signed `welcome` roster to come back through its OWN mailbox. Until
 * that arrives, the pending row here lets the scheduler re-post the request each
 * drain cycle (idempotent — a re-post is a rejoin on the inviter side) and lets
 * the drain AUTHENTICATE an inbound welcome: it is accepted only if a pending
 * join exists for that circle whose inviter_pubkey matches the welcome's signer,
 * so an unsolicited (or forged-signer) welcome can never import a bogus circle.
 *
 * The row holds the invitee's own single-use secret + join envelope so the
 * request can be rebuilt without re-parsing the code. Single-use + expiring, and
 * for a circle the invitee is actively trying to join, so at-rest exposure is
 * bounded and no worse than holding the invite code itself.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CircleEnvelope } from "./envelope.js";

export type PendingJoin = {
  inviteId: string;
  circleId: string;
  inviterPubkey: string;
  inviterMailboxUrl: string;
  inviterBoxPubkey: string;
  secret: string;
  joinEnvelope: CircleEnvelope;
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  createdAt: number;
};

type Row = {
  invite_id: string;
  circle_id: string;
  inviter_pubkey: string;
  inviter_mailbox_url: string;
  inviter_box_pubkey: string;
  secret: string;
  join_envelope_json: string;
  attempts: number;
  next_attempt_at: number;
  expires_at: number;
  created_at: number;
};

/**
 * Exponential backoff for re-posting a pending join: 30s doubling to a 1h cap.
 * An offline inviter therefore costs the invitee ~a handful of posts in the
 * first hour then hourly, keeping total posts over the 7-day invite life well
 * under the mailbox RECIPIENT_QUOTA (500) instead of ~5,760/day at the raw poll
 * cadence — no self-DoS of the inviter's mailbox.
 */
export function pendingJoinBackoffMs(attempts: number): number {
  const base = 30_000;
  const cap = 60 * 60_000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
}

function toPendingJoin(r: Row): PendingJoin {
  return {
    inviteId: r.invite_id,
    circleId: r.circle_id,
    inviterPubkey: r.inviter_pubkey,
    inviterMailboxUrl: r.inviter_mailbox_url,
    inviterBoxPubkey: r.inviter_box_pubkey,
    secret: r.secret,
    joinEnvelope: JSON.parse(r.join_envelope_json) as CircleEnvelope,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

/**
 * Record (or reset) a pending mailbox join. Idempotent on invite_id; a re-redeem
 * of the same invite resets the backoff. Callers post the first request
 * immediately, so the first RE-post is scheduled one backoff step out.
 */
export function upsertPendingJoin(db: DatabaseSync, join: PendingJoin): void {
  const nextAttemptAt = join.createdAt + pendingJoinBackoffMs(1);
  db.prepare(
    `INSERT INTO circle_pending_join
       (invite_id, circle_id, inviter_pubkey, inviter_mailbox_url, inviter_box_pubkey,
        secret, join_envelope_json, attempts, next_attempt_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(invite_id) DO UPDATE SET
       inviter_mailbox_url = excluded.inviter_mailbox_url,
       inviter_box_pubkey  = excluded.inviter_box_pubkey,
       attempts            = 1,
       next_attempt_at     = excluded.next_attempt_at`,
  ).run(
    join.inviteId,
    join.circleId,
    join.inviterPubkey,
    join.inviterMailboxUrl,
    join.inviterBoxPubkey,
    join.secret,
    JSON.stringify(join.joinEnvelope),
    nextAttemptAt,
    join.expiresAt,
    join.createdAt,
  );
}

/**
 * Pending joins whose backoff timer is DUE (for re-posting). Expired rows are
 * GC'd first so a dead invite stops costing posts.
 */
export function listDuePendingJoins(db: DatabaseSync, now: number): PendingJoin[] {
  db.prepare(`DELETE FROM circle_pending_join WHERE expires_at < ?`).run(now);
  const rows = db
    .prepare(`SELECT * FROM circle_pending_join WHERE next_attempt_at <= ? ORDER BY created_at ASC`)
    .all(now) as unknown as Row[];
  return rows.map(toPendingJoin);
}

/** Advance a pending join's backoff after a (re-)post attempt. */
export function bumpPendingJoinAttempt(db: DatabaseSync, inviteId: string, now: number): void {
  const row = db
    .prepare(`SELECT attempts FROM circle_pending_join WHERE invite_id = ?`)
    .get(inviteId) as { attempts: number } | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  db.prepare(
    `UPDATE circle_pending_join SET attempts = ?, next_attempt_at = ? WHERE invite_id = ?`,
  ).run(attempts, now + pendingJoinBackoffMs(attempts), inviteId);
}

/**
 * The pending join a welcome could satisfy: same circle, signed by the pubkey
 * that signed the invite, not yet expired. Returns null otherwise (an
 * unsolicited, wrong-signer, or stale welcome).
 */
export function matchPendingJoin(
  db: DatabaseSync,
  circleId: string,
  inviterPubkey: string,
  now: number,
): PendingJoin | null {
  const row = db
    .prepare(
      `SELECT * FROM circle_pending_join
        WHERE circle_id = ? AND inviter_pubkey = ? AND expires_at >= ?`,
    )
    .get(circleId, inviterPubkey, now) as Row | undefined;
  return row ? toPendingJoin(row) : null;
}

/** Clear a pending join once its welcome has been imported. */
export function deletePendingJoin(db: DatabaseSync, inviteId: string): void {
  db.prepare(`DELETE FROM circle_pending_join WHERE invite_id = ?`).run(inviteId);
}
