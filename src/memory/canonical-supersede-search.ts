/**
 * PLAN-55 Phase 2 (G4), consumer 1: search down-weighting.
 *
 * When the ledger's value for a key changes, older memory chunks that state
 * the old value are marked in `chunk_supersessions` (migration v78).
 * memory search keeps returning them (history is evidence, never hidden) but
 * ranks them after every current result, halves their score and tags the
 * snippet `[superseded]` with the key's current value. A pin back to the old
 * value deletes the marks, so "re-pin" is a full undo.
 *
 * Matching is bounded and token-aware: the old value must appear in the
 * chunk text as a whole token sequence (case-insensitive, letters and digits
 * on either side break the match), trivially short or generic values are
 * skipped, and a chunk that also states the new value is left alone (it is
 * describing the change, not restating the old belief). Candidate chunks come
 * from the FTS index when it is available, otherwise from a windowed rowid
 * scan that yields between windows; both paths cap their work per event.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalChangeMarksStale, type CanonicalChangeEvent } from "./canonical-events.js";
import { normalizeExact } from "./memory-suppressions.js";
import type { MemorySearchResult } from "./types.js";

const log = createSubsystemLogger("memory/canonical-propagation");

/** Values shorter than this never mark anything ("no", "v2", "42"). */
export const MIN_STALE_VALUE_CHARS = 3;
/** Values longer than this are prose; a verbatim match would be luck. */
export const MAX_STALE_VALUE_CHARS = 200;
/** At most this many chunks are marked per event. */
export const MAX_MARKS_PER_EVENT = 200;
/** Rows read per scan window before yielding the event loop. */
export const SCAN_WINDOW_ROWS = 2_000;
/** Rows scanned per event at most (fallback path, no FTS). */
export const MAX_SCAN_ROWS = 200_000;
/** Score multiplier for a superseded result (it also sorts after current ones). */
export const SUPERSEDED_SCORE_FACTOR = 0.5;
export const SUPERSEDED_TAG = "[superseded]";

const GENERIC_VALUES = new Set([
  "yes",
  "no",
  "true",
  "false",
  "none",
  "null",
  "n/a",
  "unknown",
  "the",
  "and",
  "off",
  "on",
]);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A token-aware, case-insensitive matcher for a fact value, or null when the
 * value is too short, too long, purely a small number, or generic.
 */
export function staleValueMatcher(
  value: string | null | undefined,
): ((text: string) => boolean) | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  if (v.length < MIN_STALE_VALUE_CHARS || v.length > MAX_STALE_VALUE_CHARS) {
    return null;
  }
  if (GENERIC_VALUES.has(v.toLowerCase()) || /^\d{1,4}$/.test(v)) {
    return null;
  }
  // No letter or digit at all: nothing token-like to anchor on.
  if (!/[\p{L}\p{N}]/u.test(v)) {
    return null;
  }
  const body = v.split(" ").map(escapeRegExp).join("\\s+");
  const rx = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
  return (text: string) => rx.test(text);
}

/** FTS5 phrase query for a value: its letter/digit tokens in order. */
export function ftsPhraseForValue(value: string): string | null {
  const tokens = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  return `"${tokens.join(" ")}"`;
}

export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

export type SupersedeSearchOptions = {
  ftsTable?: string | null;
  maxMarks?: number;
  windowRows?: number;
  maxScanRows?: number;
};

export type SupersedeSearchResult = { marked: number; cleared: number; scanned: number };

/**
 * Apply one change event to `chunk_supersessions`. Idempotent: marks are
 * keyed (chunk, key, stale value) and inserted OR IGNORE; clearing and the
 * current-value refresh are plain UPDATE/DELETE by key.
 */
export async function propagateSupersededChunks(
  db: DatabaseSync,
  event: CanonicalChangeEvent,
  opts: SupersedeSearchOptions = {},
): Promise<SupersedeSearchResult> {
  const result: SupersedeSearchResult = { marked: 0, cleared: 0, scanned: 0 };
  // The value is current again: chunks stating it are no longer stale.
  if (event.newValue) {
    result.cleared = Number(
      db
        .prepare(`DELETE FROM chunk_supersessions WHERE fact_key = ? AND stale_value = ?`)
        .run(event.key, normalizeExact(event.newValue)).changes,
    );
  }
  // Remaining marks for the key point at the latest belief (null = retired).
  // A soft retire (agent, decay) leaves them alone: the value it retired is
  // not known to be wrong, and the tag would otherwise lose the value the
  // owner last set.
  if (event.op !== "retire" || event.retireReason === "owner") {
    db.prepare(
      `UPDATE chunk_supersessions SET current_value = ?, fact_id = ? WHERE fact_key = ?`,
    ).run(event.newValue, event.factId, event.key);
  }
  if (!canonicalChangeMarksStale(event)) {
    return result;
  }
  const matchesOld = staleValueMatcher(event.oldValue);
  if (!matchesOld) {
    return result;
  }
  const matchesNew = staleValueMatcher(event.newValue);
  const maxMarks = opts.maxMarks ?? MAX_MARKS_PER_EVENT;
  const staleValue = normalizeExact(event.oldValue!);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO chunk_supersessions
       (chunk_id, fact_key, stale_value, fact_id, current_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const evidence = new Set(event.evidence.chunkIds);
  const consider = (row: { id: string; text: string }): void => {
    if (result.marked >= maxMarks || evidence.has(row.id)) {
      return;
    }
    if (!matchesOld(row.text) || matchesNew?.(row.text)) {
      return;
    }
    const changes = Number(
      insert.run(row.id, event.key, staleValue, event.factId, event.newValue, event.at).changes,
    );
    result.marked += changes;
  };

  const viaFts = await scanViaFts(db, event.oldValue!, opts, consider, result);
  if (!viaFts) {
    await scanChunksWindowed(db, opts, consider, result, maxMarks);
  }
  if (result.marked > 0) {
    log.info(
      `canonical:changed [${event.key}] marked ${result.marked} chunk(s) superseded ` +
        `(scanned ${result.scanned})`,
    );
  }
  return result;
}

async function scanViaFts(
  db: DatabaseSync,
  oldValue: string,
  opts: SupersedeSearchOptions,
  consider: (row: { id: string; text: string }) => void,
  result: SupersedeSearchResult,
): Promise<boolean> {
  const table = opts.ftsTable;
  const phrase = ftsPhraseForValue(oldValue);
  if (!table || !phrase) {
    return false;
  }
  let ids: string[];
  try {
    const cap = (opts.maxMarks ?? MAX_MARKS_PER_EVENT) * 5;
    ids = (
      db
        .prepare(`SELECT id FROM ${table} WHERE ${table} MATCH ? LIMIT ?`)
        .all(phrase, cap) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
  } catch (err) {
    log.debug(`supersede FTS lookup failed, scanning instead: ${String(err)}`);
    return false;
  }
  const load = db.prepare(`SELECT id, text FROM chunks WHERE id = ?`);
  for (let i = 0; i < ids.length; i++) {
    const row = load.get(ids[i]!) as { id: string; text: string } | undefined;
    result.scanned++;
    if (row) {
      consider(row);
    }
    if (i % 100 === 99) {
      await yieldToEventLoop();
    }
  }
  return true;
}

async function scanChunksWindowed(
  db: DatabaseSync,
  opts: SupersedeSearchOptions,
  consider: (row: { id: string; text: string }) => void,
  result: SupersedeSearchResult,
  maxMarks: number,
): Promise<void> {
  const windowRows = opts.windowRows ?? SCAN_WINDOW_ROWS;
  const maxScan = opts.maxScanRows ?? MAX_SCAN_ROWS;
  const page = db.prepare(
    `SELECT rowid AS rid, id, text FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  );
  let after = 0;
  while (result.scanned < maxScan && result.marked < maxMarks) {
    const rows = page.all(after, windowRows) as unknown as Array<{
      rid: number;
      id: string;
      text: string;
    }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      consider(row);
    }
    result.scanned += rows.length;
    after = rows[rows.length - 1]!.rid;
    await yieldToEventLoop();
  }
}

type SupersessionRow = { fact_key: string; current_value: string | null };

/**
 * Search-time half: tag results that sit on a superseded chunk, halve their
 * score and move them after every current result (stable within each
 * group), in place. Results are matched to chunks the way search tracking does it
 * (path + line range), disambiguated by the snippet when a path holds
 * several line-0 fact chunks. Best-effort: any failure returns the input.
 */
export function applySupersededMarks(
  db: DatabaseSync,
  results: MemorySearchResult[],
): MemorySearchResult[] {
  if (results.length === 0) {
    return results;
  }
  try {
    if (!db.prepare(`SELECT 1 FROM chunk_supersessions LIMIT 1`).get()) {
      return results;
    }
    const chunksAt = db.prepare(
      `SELECT id, text FROM chunks WHERE path = ? AND start_line = ? AND end_line = ? LIMIT 20`,
    );
    const marksFor = db.prepare(
      `SELECT fact_key, current_value FROM chunk_supersessions WHERE chunk_id = ? LIMIT 5`,
    );
    const current: MemorySearchResult[] = [];
    const superseded: MemorySearchResult[] = [];
    for (const r of results) {
      const chunks = chunksAt.all(r.path, r.startLine, r.endLine) as Array<{
        id: string;
        text: string;
      }>;
      const probe = r.snippet.trim().slice(0, 80);
      const chunk =
        chunks.length === 1 ? chunks[0] : chunks.find((c) => probe && c.text.includes(probe));
      const marks = chunk ? (marksFor.all(chunk.id) as unknown as SupersessionRow[]) : [];
      if (marks.length === 0) {
        current.push(r);
        continue;
      }
      if (r.snippet.startsWith(SUPERSEDED_TAG)) {
        superseded.push(r);
        continue;
      }
      const notes = marks.map((m) =>
        m.current_value === null
          ? `${m.fact_key} was retired`
          : `${m.fact_key} is now "${m.current_value}"`,
      );
      superseded.push({
        ...r,
        score: r.score * SUPERSEDED_SCORE_FACTOR,
        snippet: `${SUPERSEDED_TAG} (${notes.join("; ")}) ${r.snippet}`,
        superseded: marks.map((m) => ({ key: m.fact_key, currentValue: m.current_value })),
      });
    }
    if (superseded.length > 0) {
      // In place: callers hold the array (manager.search returns it).
      results.splice(0, results.length, ...current, ...superseded);
    }
    return results;
  } catch (err) {
    log.debug(`superseded tagging skipped: ${String(err)}`);
    return results;
  }
}
