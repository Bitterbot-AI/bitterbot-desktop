/**
 * Session extraction failure ledger (token-efficiency pass, 2026-09-19).
 *
 * `extractSessionFacts` returns null on an LLM error or an unparseable /
 * truncated response, and the manager wrote no `session_extractions` row in
 * that case, so the same transcript was retried on every dream cycle (27 of
 * 52 extraction calls on the reference node were one Sep-3 file). Failures
 * are now recorded per (path, content hash); after `maxAttempts` the
 * transcript is skipped until its content changes or `retryAfterMs` elapses.
 */

import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_EXTRACTION_MAX_ATTEMPTS = 2;
export const DEFAULT_EXTRACTION_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type ExtractionFailureRow = {
  session_path: string;
  content_hash: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: number;
};

export function ensureExtractionFailureSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_extraction_failures (
       session_path TEXT PRIMARY KEY,
       content_hash TEXT NOT NULL,
       attempts INTEGER NOT NULL DEFAULT 0,
       last_error TEXT,
       last_attempt_at INTEGER NOT NULL
     )`,
  );
}

export function readExtractionFailure(
  db: DatabaseSync,
  sessionPath: string,
): ExtractionFailureRow | null {
  ensureExtractionFailureSchema(db);
  const row = db
    .prepare(`SELECT * FROM session_extraction_failures WHERE session_path = ?`)
    .get(sessionPath) as unknown as ExtractionFailureRow | undefined;
  return row ?? null;
}

/**
 * True when this transcript (at this content hash) has exhausted its attempts
 * and the retry window has not elapsed. A changed hash always resets.
 */
export function shouldSkipExtraction(
  db: DatabaseSync,
  sessionPath: string,
  contentHash: string,
  opts?: { maxAttempts?: number; retryAfterMs?: number; now?: number },
): boolean {
  const row = readExtractionFailure(db, sessionPath);
  if (!row || row.content_hash !== contentHash) {
    return false;
  }
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_EXTRACTION_MAX_ATTEMPTS);
  if (row.attempts < maxAttempts) {
    return false;
  }
  const retryAfterMs = opts?.retryAfterMs ?? DEFAULT_EXTRACTION_RETRY_AFTER_MS;
  const now = opts?.now ?? Date.now();
  return now - row.last_attempt_at < retryAfterMs;
}

/** Record one failed attempt; a new content hash restarts the count at 1. */
export function recordExtractionFailure(
  db: DatabaseSync,
  sessionPath: string,
  contentHash: string,
  error: string,
  now = Date.now(),
): ExtractionFailureRow {
  const prev = readExtractionFailure(db, sessionPath);
  const attempts = prev && prev.content_hash === contentHash ? prev.attempts + 1 : 1;
  db.prepare(
    `INSERT INTO session_extraction_failures (session_path, content_hash, attempts, last_error, last_attempt_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_path) DO UPDATE SET
       content_hash = excluded.content_hash,
       attempts = excluded.attempts,
       last_error = excluded.last_error,
       last_attempt_at = excluded.last_attempt_at`,
  ).run(sessionPath, contentHash, attempts, error.slice(0, 500), now);
  return {
    session_path: sessionPath,
    content_hash: contentHash,
    attempts,
    last_error: error.slice(0, 500),
    last_attempt_at: now,
  };
}

export function clearExtractionFailure(db: DatabaseSync, sessionPath: string): void {
  ensureExtractionFailureSchema(db);
  db.prepare(`DELETE FROM session_extraction_failures WHERE session_path = ?`).run(sessionPath);
}

/** Doctor / status helper: transcripts currently parked by the ledger. */
export function listExtractionFailures(db: DatabaseSync, limit = 50): ExtractionFailureRow[] {
  ensureExtractionFailureSchema(db);
  return db
    .prepare(`SELECT * FROM session_extraction_failures ORDER BY last_attempt_at DESC LIMIT ?`)
    .all(limit) as unknown as ExtractionFailureRow[];
}
