/**
 * PLAN-31 C2 §3.5: the disclosure allowlist — default-deny consent for what
 * our agent may share with connected friends' agents autonomously.
 *
 * Built-in allowances (the ONLY two, per the v1 connection-first default):
 *   - presence  (liveness; the heartbeat already carries it)
 *   - availability (free/busy shape, never why)
 *
 * Everything else — answering an "ask your people" question, sharing
 * anything from the user's private memory — requires an explicit per-category
 * grant written by the HUMAN (circles.disclosure.set), scoped to one circle
 * or '*'. The default answer posture without a grant is the polite refusal:
 * "my human can see this question; I'll reply if they've allowed this topic."
 *
 * Categories are free strings (dot-namespaced by convention:
 * "recommendations.dentist", "schedule.trips") so grants stay as granular as
 * the human wants. Resolution precedence: circle-specific row > '*' row >
 * built-in > DENY.
 */

import type { DatabaseSync } from "node:sqlite";

export const BUILTIN_ALLOWED_CATEGORIES = new Set(["presence", "availability"]);

export type DisclosureGrant = {
  category: string;
  circleId: string; // '*' = all circles
  allowed: boolean;
  updatedAt: number;
};

export function setDisclosureGrant(
  db: DatabaseSync,
  args: { category: string; circleId?: string; allowed: boolean; now?: number },
): void {
  const now = args.now ?? Date.now();
  const category = args.category.trim().toLowerCase();
  if (!category) {
    throw new Error("category required");
  }
  db.prepare(
    `INSERT INTO circle_disclosure_grants (category, circle_id, allowed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(category, circle_id) DO UPDATE SET
       allowed = excluded.allowed, updated_at = excluded.updated_at`,
  ).run(category, args.circleId ?? "*", args.allowed ? 1 : 0, now, now);
}

export function listDisclosureGrants(db: DatabaseSync): DisclosureGrant[] {
  const rows = db
    .prepare(
      `SELECT category, circle_id, allowed, updated_at FROM circle_disclosure_grants
        ORDER BY category, circle_id`,
    )
    .all() as unknown as Array<{
    category: string;
    circle_id: string;
    allowed: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    category: r.category,
    circleId: r.circle_id,
    allowed: r.allowed === 1,
    updatedAt: r.updated_at,
  }));
}

/**
 * May our agent autonomously disclose `category` into `circleId`?
 * Precedence: circle-specific grant > wildcard grant > built-in > deny.
 * An explicit allowed=false row is a REVOCATION that also overrides the
 * built-ins (the human can turn presence sharing off).
 */
export function isDisclosureAllowed(db: DatabaseSync, category: string, circleId: string): boolean {
  const normalized = category.trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT circle_id, allowed FROM circle_disclosure_grants
        WHERE category = ? AND circle_id IN (?, '*')`,
    )
    .all(normalized, circleId) as unknown as Array<{ circle_id: string; allowed: number }>;
  const specific = rows.find((r) => r.circle_id === circleId);
  if (specific) {
    return specific.allowed === 1;
  }
  const wildcard = rows.find((r) => r.circle_id === "*");
  if (wildcard) {
    return wildcard.allowed === 1;
  }
  return BUILTIN_ALLOWED_CATEGORIES.has(normalized);
}

/** The §3.5 default posture, sent once per unanswered ask we cannot serve. */
export const DEFAULT_ANSWER_POSTURE =
  "My human can see this question; I'll reply if they've allowed this topic.";

export type PendingAsk = {
  messageId: string;
  circleId: string;
  authorPubkey: string;
  threadId: string | null;
  category: string | null;
  createdAt: number;
};

/**
 * Inbound asks we have not answered yet (no outbound answer in the same
 * thread). The category rides in the ask's thread_id by convention
 * ("<category>:<uuid>") when the asker declared one; otherwise null (which
 * can never match a grant — undeclared asks always get the default posture).
 */
export function pendingAsks(db: DatabaseSync, now: number = Date.now()): PendingAsk[] {
  const rows = db
    .prepare(
      `SELECT m.message_id, m.circle_id, m.author_pubkey, m.thread_id, m.created_at
         FROM circle_messages m
        WHERE m.direction = 'in' AND m.kind = 'ask'
          AND m.thread_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM circle_messages a
             WHERE a.circle_id = m.circle_id AND a.direction = 'out'
               AND a.kind = 'answer' AND a.thread_id = m.thread_id
          )
        ORDER BY m.created_at ASC LIMIT 50`,
    )
    .all() as unknown as Array<{
    message_id: string;
    circle_id: string;
    author_pubkey: string;
    thread_id: string | null;
    created_at: number;
  }>;
  void now;
  return rows.map((r) => {
    const threadId = r.thread_id;
    const colon = threadId?.indexOf(":") ?? -1;
    return {
      messageId: r.message_id,
      circleId: r.circle_id,
      authorPubkey: r.author_pubkey,
      threadId,
      category: threadId && colon > 0 ? threadId.slice(0, colon).toLowerCase() : null,
      createdAt: r.created_at,
    };
  });
}
