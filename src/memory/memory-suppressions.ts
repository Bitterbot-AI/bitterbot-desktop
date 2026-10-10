/**
 * PLAN-55 Phase 0: sticky owner decisions.
 *
 * When the owner forgets a memory, retires a settled fact or removes a
 * learned preference, the deletion alone is not enough: session extraction,
 * preference extraction, curiosity research and dream promotion all rebuild
 * their output from the same inputs, so the same memory grows back with a
 * fresh id the next time the transcript hash changes. The
 * `memory_suppressions` table (migration v76) is the owner's standing "no":
 * every background writer consults it before inserting, and only an owner
 * action lifts a row.
 *
 * Three kinds, three hash functions (all deterministic, documented here so a
 * writer and a consumer can never disagree):
 *
 * - `chunk_hash`: sha256 of the memory text after trim, whitespace collapse
 *   and lowercasing (`chunkTextHash`). Extraction output varies in
 *   whitespace and case between runs; the hash must not.
 * - `fact_key_value`: sha256 of `<normalized key>\u0000<normalized value>`
 *   (`factKeyValueHash`), key as the ledger slug, value trimmed, whitespace
 *   collapsed, lowercased. The ledger compares values exactly, so a
 *   case-variant of a retired value would otherwise SUPERSEDE its way back.
 * - `preference_key`: `<category>\u0000<key>`, both trimmed and lowercased
 *   (`preferenceKeyHash`). Not hashed: the key is already a short slug.
 *
 * Every function takes the database handle per call (the manager swaps it
 * during a reindex) and never throws on a database that predates v76: a
 * missing table reads as "nothing suppressed".
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SuppressionKind = "chunk_hash" | "fact_key_value" | "preference_key";

export type Suppression = {
  id: string;
  kind: SuppressionKind;
  hash: string;
  createdAt: number;
  reason: string | null;
  actor: string;
};

const normalizeText = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Hash for `chunk_hash` suppressions: sha256 of the normalised memory text. */
export function chunkTextHash(text: string): string {
  return crypto.createHash("sha256").update(normalizeText(text)).digest("hex");
}

/** Hash for `fact_key_value` suppressions: sha256 of `key\u0000value`, both normalised. */
export function factKeyValueHash(key: string, value: string): string {
  return crypto
    .createHash("sha256")
    .update(`${normalizeText(key)}\u0000${normalizeText(value)}`)
    .digest("hex");
}

/** Hash for `preference_key` suppressions: `category\u0000key`, both normalised. */
export function preferenceKeyHash(category: string, key: string): string {
  return `${normalizeText(category)}\u0000${normalizeText(key)}`;
}

type SuppressionRow = {
  id: string;
  kind: string;
  hash: string;
  created_at: number;
  reason: string | null;
  actor: string;
};

const rowToSuppression = (r: SuppressionRow): Suppression => ({
  id: r.id,
  kind: r.kind as SuppressionKind,
  hash: r.hash,
  createdAt: r.created_at,
  reason: r.reason,
  actor: r.actor,
});

/**
 * Record a suppression. Idempotent on (kind, hash): a second call returns the
 * existing row's id and leaves its reason and actor alone.
 */
export function addSuppression(
  db: DatabaseSync,
  input: { kind: SuppressionKind; hash: string; reason?: string; actor?: string },
): Suppression {
  const existing = isSuppressed(db, input.kind, input.hash);
  if (existing) {
    return existing;
  }
  const row: Suppression = {
    id: crypto.randomUUID(),
    kind: input.kind,
    hash: input.hash,
    createdAt: Date.now(),
    reason: input.reason ?? null,
    actor: input.actor ?? "owner",
  };
  db.prepare(
    `INSERT OR IGNORE INTO memory_suppressions (id, kind, hash, created_at, reason, actor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.kind, row.hash, row.createdAt, row.reason, row.actor);
  // A concurrent insert can win the unique index; report whichever row holds it.
  return isSuppressed(db, input.kind, input.hash) ?? row;
}

/** The suppression for (kind, hash), or null. Null on a pre-v76 database. */
export function isSuppressed(
  db: DatabaseSync,
  kind: SuppressionKind,
  hash: string,
): Suppression | null {
  try {
    const row = db
      .prepare(
        `SELECT id, kind, hash, created_at, reason, actor FROM memory_suppressions WHERE kind = ? AND hash = ?`,
      )
      .get(kind, hash) as SuppressionRow | undefined;
    return row ? rowToSuppression(row) : null;
  } catch {
    return null;
  }
}

/** Remove a suppression. Returns true when a row was deleted. */
export function liftSuppression(db: DatabaseSync, kind: SuppressionKind, hash: string): boolean {
  try {
    const res = db
      .prepare(`DELETE FROM memory_suppressions WHERE kind = ? AND hash = ?`)
      .run(kind, hash);
    return Number(res.changes) > 0;
  } catch {
    return false;
  }
}

/** Suppressions, newest first, optionally one kind. */
export function listSuppressions(
  db: DatabaseSync,
  opts: { kind?: SuppressionKind; limit?: number } = {},
): Suppression[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  try {
    const rows = (opts.kind
      ? db
          .prepare(
            `SELECT id, kind, hash, created_at, reason, actor FROM memory_suppressions
                WHERE kind = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(opts.kind, limit)
      : db
          .prepare(
            `SELECT id, kind, hash, created_at, reason, actor FROM memory_suppressions
                ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit)) as unknown as SuppressionRow[];
    return rows.map(rowToSuppression);
  } catch {
    return [];
  }
}
