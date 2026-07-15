/**
 * PLAN-36 §5.3 (Phase 0): server-enforced two-phase gate for agent circle
 * writes.
 *
 * The `circles` agent tool's send/ask/log_expense are meant to be two-phase:
 * preview -> human approves -> confirm. But the confirm was prompt-convention
 * only — a single call with confirm=true executed immediately, so a prompt-
 * injected agent could bypass the preview entirely. This module makes the
 * contract real: the preview mints a single-use token bound to the exact
 * action + params, persisted in circle_pending_outbound (migration v37); the
 * confirm leg must present a matching, unused, unexpired token or it is
 * refused.
 *
 * NOTE (interim): the token is minted at PREVIEW time, which enforces
 * "a preview was rendered for these exact params, exactly once" — it closes
 * confirm-on-first-call, replay, and params-swap. It does not yet require a
 * HUMAN action, because the approval UI (the inline pending-outbound card,
 * PLAN-36 Phase 2/3) does not exist. When that card ships, mint the token from
 * the human's approve action instead of the preview; the table and the confirm
 * check here are unchanged.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

/** How long a preview token stays valid. */
export const PENDING_OUTBOUND_TTL_MS = 10 * 60_000;

/**
 * Canonical hash of an action + its params, so a token minted for one preview
 * cannot authorize a different send. Callers must build `params` identically at
 * preview and confirm time (stable key order via the caller's object literal;
 * arrays should be pre-sorted by the caller).
 */
export function hashPendingParams(action: string, params: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify({ action, params })).digest("hex");
}

/** Mint + persist a single-use token for a previewed action. */
export function createPendingOutbound(
  db: DatabaseSync,
  action: string,
  paramsHash: string,
  now: number,
): string {
  const token = crypto.randomUUID();
  db.prepare(
    `INSERT INTO circle_pending_outbound (token, action, params_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, action, paramsHash, now, now + PENDING_OUTBOUND_TTL_MS);
  // Opportunistic GC of expired/used rows (cheap, bounded, no scheduler needed).
  db.prepare(`DELETE FROM circle_pending_outbound WHERE expires_at < ? OR used_at IS NOT NULL`).run(
    now,
  );
  return token;
}

export type ConsumeResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify + consume a confirm token. Fails (without consuming) when the token is
 * missing/unknown, already used, expired, or was minted for a different
 * action+params. On success marks it used so it cannot be replayed.
 */
export function consumePendingOutbound(
  db: DatabaseSync,
  token: string | undefined,
  action: string,
  paramsHash: string,
  now: number,
): ConsumeResult {
  if (!token) {
    return {
      ok: false,
      reason: "missing confirm_token — call once WITHOUT confirm to preview first",
    };
  }
  const row = db
    .prepare(
      `SELECT action, params_hash, expires_at, used_at FROM circle_pending_outbound WHERE token = ?`,
    )
    .get(token) as
    | { action: string; params_hash: string; expires_at: number; used_at: number | null }
    | undefined;
  if (!row) {
    return { ok: false, reason: "unknown confirm_token — preview again to get a fresh one" };
  }
  if (row.used_at !== null) {
    return { ok: false, reason: "confirm_token already used — preview again for a new one" };
  }
  if (row.expires_at < now) {
    return { ok: false, reason: "confirm_token expired — preview again" };
  }
  if (row.action !== action || row.params_hash !== paramsHash) {
    return {
      ok: false,
      reason: "confirm_token does not match this action/params — preview the exact message first",
    };
  }
  db.prepare(`UPDATE circle_pending_outbound SET used_at = ? WHERE token = ?`).run(now, token);
  return { ok: true };
}
