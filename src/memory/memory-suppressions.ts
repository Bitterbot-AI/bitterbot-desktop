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
 * Four kinds, with their hash functions (all deterministic, documented here
 * so a writer and a consumer can never disagree):
 *
 * - `chunk_hash`: sha256 of the memory text after loose normalisation
 *   (`chunkTextHash`): lowercase, every character that is not a letter or
 *   digit (unicode-aware) becomes a space, whitespace collapsed. Extraction
 *   output varies in punctuation, case and spacing between runs; a
 *   materially reworded memory is a different memory and may come back.
 * - `fact_key_value`: sha256 of `<key>\u0000<value>` (`factKeyValueHash`),
 *   key as the ledger slug, value trimmed, whitespace collapsed, lowercased.
 *   Exact apart from that: the ledger compares values exactly, so a
 *   case-variant of a retired value would otherwise SUPERSEDE its way back.
 * - `preference_key`: `<category>\u0000<key>`, both trimmed and lowercased
 *   (`preferenceKeyHash`). Not hashed: the key is already a short slug.
 * - `preference_value`: sha256 of `<category>\u0000<loosely normalised
 *   value>` (`preferenceValueHash`); the normalised value is kept in the
 *   `text` column so a reworded directive can be compared by word overlap
 *   (`directiveSimilarity`) against what the owner removed.
 *
 * Every function takes the database handle per call (the manager swaps it
 * during a reindex). Reads never throw on a database that predates v76 (a
 * missing table reads as "nothing suppressed"); writes do throw, so an owner
 * action that could not be made sticky fails as a whole instead of leaving
 * a deletion without its suppression.
 */

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SuppressionKind =
  | "chunk_hash"
  | "fact_key_value"
  | "preference_key"
  | "preference_value";

export type Suppression = {
  id: string;
  kind: SuppressionKind;
  hash: string;
  createdAt: number;
  reason: string | null;
  actor: string;
  /** The normalised text behind the hash, kept only where a consumer compares by similarity. */
  text: string | null;
};

/** Trim, collapse whitespace, lowercase. Exact otherwise. */
export const normalizeExact = (text: string): string =>
  text.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Lowercase, drop everything that is not a letter or a digit (any script),
 * collapse whitespace. "The deploy endpoint is api.acme.com." and "the
 * deploy endpoint is API acme com" normalise to the same string.
 */
export const normalizeLoose = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** Hash for `chunk_hash` suppressions: sha256 of the loosely normalised memory text. */
export function chunkTextHash(text: string): string {
  return sha256(normalizeLoose(text));
}

/** Hash for `fact_key_value` suppressions: sha256 of `key\u0000value`, both exact-normalised. */
export function factKeyValueHash(key: string, value: string): string {
  return sha256(`${normalizeExact(key)}\u0000${normalizeExact(value)}`);
}

/** Hash for `preference_key` suppressions: `category\u0000key`, both exact-normalised. */
export function preferenceKeyHash(category: string, key: string): string {
  return `${normalizeExact(category)}\u0000${normalizeExact(key)}`;
}

/** Hash for `preference_value` suppressions: sha256 of `category\u0000<loose value>`. */
export function preferenceValueHash(category: string, value: string): string {
  return sha256(`${normalizeExact(category)}\u0000${normalizeLoose(value)}`);
}

type SuppressionRow = {
  id: string;
  kind: string;
  hash: string;
  created_at: number;
  reason: string | null;
  actor: string;
  text: string | null;
};

const COLUMNS = "id, kind, hash, created_at, reason, actor, text";

const rowToSuppression = (r: SuppressionRow): Suppression => ({
  id: r.id,
  kind: r.kind as SuppressionKind,
  hash: r.hash,
  createdAt: r.created_at,
  reason: r.reason,
  actor: r.actor,
  text: r.text ?? null,
});

/**
 * Record a suppression. Idempotent on (kind, hash): a second call returns the
 * existing row and leaves its reason and actor alone. Throws when the table
 * is missing: the caller's transaction must roll back.
 */
export function addSuppression(
  db: DatabaseSync,
  input: { kind: SuppressionKind; hash: string; reason?: string; actor?: string; text?: string },
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
    text: input.text ?? null,
  };
  db.prepare(
    `INSERT OR IGNORE INTO memory_suppressions (id, kind, hash, created_at, reason, actor, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.kind, row.hash, row.createdAt, row.reason, row.actor, row.text);
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
      .prepare(`SELECT ${COLUMNS} FROM memory_suppressions WHERE kind = ? AND hash = ?`)
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
            `SELECT ${COLUMNS} FROM memory_suppressions
                WHERE kind = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(opts.kind, limit)
      : db
          .prepare(`SELECT ${COLUMNS} FROM memory_suppressions ORDER BY created_at DESC LIMIT ?`)
          .all(limit)) as unknown as SuppressionRow[];
    return rows.map(rowToSuppression);
  } catch {
    return [];
  }
}

/**
 * Run `fn` inside a savepoint so it composes with a caller's transaction and
 * stands alone otherwise. An error rolls the savepoint back and rethrows, so
 * an owner write is applied whole or not at all.
 */
export function inSavepoint<T>(db: DatabaseSync, name: string, fn: () => T): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      // The savepoint is gone with the failed statement; nothing more to undo.
    }
    throw err;
  }
}
