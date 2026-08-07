/**
 * PLAN-36 Phase A2 (chat shell): node-local per-circle read state.
 *
 * Unread is a purely LOCAL concern — "have I looked at this circle since the
 * last inbound message?" — so it never rides the wire and needs no signing.
 * A single `last_read_at` marker per circle; unread = inbound messages newer
 * than the marker. Opening a circle marks it read (up to now); the rail badges
 * whatever's newer. Outbound (our own) messages never count as unread.
 */

import type { DatabaseSync } from "node:sqlite";

/** Mark a circle read up to `now` (called when the human opens it). */
export function markCircleRead(db: DatabaseSync, circleId: string, now: number): void {
  db.prepare(
    `INSERT INTO circle_read_state (circle_id, last_read_at) VALUES (?, ?)
     ON CONFLICT(circle_id) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
  ).run(circleId, now);
}

/**
 * The raw read markers per circle (ms epoch of the last mark-read). The UI
 * freezes this at circle-open to place the "New" divider — the marker itself
 * moves forward the moment the circle is opened, so the divider must be
 * derived from the value as it stood *before* that bump.
 */
export function readMarkers(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(`SELECT circle_id AS circleId, last_read_at AS lastReadAt FROM circle_read_state`)
    .all() as unknown as Array<{ circleId: string; lastReadAt: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.circleId] = row.lastReadAt;
  return out;
}

/**
 * Unread inbound count per circle: inbound messages newer than the read marker
 * (missing marker → everything inbound counts, e.g. a freshly-joined circle).
 * Returns a plain map so callers can attach it to circles.list rows.
 */
export function unreadCounts(db: DatabaseSync): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT m.circle_id AS circleId, COUNT(*) AS n
         FROM circle_messages m
         LEFT JOIN circle_read_state r ON r.circle_id = m.circle_id
        WHERE m.direction = 'in' AND m.deleted_at IS NULL
          AND m.created_at > COALESCE(r.last_read_at, 0)
        GROUP BY m.circle_id`,
    )
    .all() as unknown as Array<{ circleId: string; n: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.circleId] = row.n;
  return out;
}
