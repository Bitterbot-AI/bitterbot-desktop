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
 * Which chunks: the old fact's own evidence (its chunk ids, and the session
 * line its evidence ref points at), plus any chunk that states the old value
 * as a whole identifier AND names the key's subject (canonical-stale-match.ts).
 * A chunk that also states the new value describes the change and is left
 * alone. Candidates come from the FTS index when available, otherwise from a
 * windowed scan; both go newest first, yield between batches and cap their
 * work per event.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  canonicalChangeMarksStale,
  type CanonicalChangeEvent,
  isOwnerDrivenRetire,
} from "./canonical-events.js";
import {
  ftsPhraseForValue,
  staleCitationMatcher,
  staleValueMatcher,
  yieldToEventLoop,
} from "./canonical-stale-match.js";
import { normalizeExact } from "./memory-suppressions.js";
import type { MemorySearchResult } from "./types.js";

export { ftsPhraseForValue, staleValueMatcher, yieldToEventLoop } from "./canonical-stale-match.js";

const log = createSubsystemLogger("memory/canonical-propagation");

/** At most this many chunks are marked per event. */
export const MAX_MARKS_PER_EVENT = 200;
/** Rows read per scan window before yielding the event loop. */
export const SCAN_WINDOW_ROWS = 2_000;
/** Rows scanned per event at most (fallback path, no FTS). */
export const MAX_SCAN_ROWS = 200_000;
/** Score multiplier for a superseded result (it also sorts after current ones). */
export const SUPERSEDED_SCORE_FACTOR = 0.5;
export const SUPERSEDED_TAG = "[superseded]";
/** Evidence ids of the old fact considered per event. */
const MAX_EVIDENCE_IDS = 50;

export type SupersedeSearchOptions = {
  ftsTable?: string | null;
  maxMarks?: number;
  windowRows?: number;
  maxScanRows?: number;
};

export type SupersedeSearchResult = { marked: number; cleared: number; scanned: number };

type ChunkRow = { id: string; text: string };

/**
 * `session:<path>#L<n>` -> chunks of that session file covering line n. The
 * path may be stored absolute or relative, so the basename is compared.
 */
function chunksForEvidenceRef(db: DatabaseSync, ref: string | null | undefined): ChunkRow[] {
  const m = ref?.match(/^session:(.+)#L(\d+)$/);
  if (!m) {
    return [];
  }
  const base = m[1]!.split(/[\\/]/).at(-1) ?? "";
  const line = Number(m[2]);
  if (!base) {
    return [];
  }
  try {
    return db
      .prepare(
        `SELECT id, text FROM chunks
          WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND start_line <= ? AND end_line >= ?
          ORDER BY updated_at DESC LIMIT 5`,
      )
      .all(
        m[1]!,
        `%/${base.replace(/[\\%_]/g, (c) => `\\${c}`)}`,
        line,
        line,
      ) as unknown as ChunkRow[];
  } catch {
    return [];
  }
}

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
  if (event.op !== "retire" || isOwnerDrivenRetire(event)) {
    db.prepare(
      `UPDATE chunk_supersessions SET current_value = ?, fact_id = ? WHERE fact_key = ?`,
    ).run(event.newValue, event.factId, event.key);
  }
  if (!canonicalChangeMarksStale(event)) {
    return result;
  }
  const matcher = staleCitationMatcher(event);
  if (!matcher) {
    return result;
  }
  const maxMarks = opts.maxMarks ?? MAX_MARKS_PER_EVENT;
  const staleValue = normalizeExact(event.oldValue!);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO chunk_supersessions
       (chunk_id, fact_key, stale_value, fact_id, current_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const newEvidence = new Set(event.evidence.chunkIds);
  const mark = (id: string): void => {
    if (result.marked < maxMarks) {
      result.marked += Number(
        insert.run(id, event.key, staleValue, event.factId, event.newValue, event.at).changes,
      );
    }
  };

  // 1. The old fact's own evidence: the chunks it was taken from. A chunk
  //    id from its evidence list is marked unless it states the new value;
  //    a chunk resolved from its session line ref must state the old value.
  const oldEvidenceIds = new Set((event.oldEvidence?.chunkIds ?? []).slice(0, MAX_EVIDENCE_IDS));
  if (oldEvidenceIds.size > 0) {
    const load = db.prepare(`SELECT id, text FROM chunks WHERE id = ?`);
    const matchesNew = staleValueMatcher(event.newValue);
    for (const id of oldEvidenceIds) {
      const row = load.get(id) as ChunkRow | undefined;
      if (row && !newEvidence.has(row.id) && !matchesNew?.(row.text)) {
        mark(row.id);
      }
    }
  }
  for (const row of chunksForEvidenceRef(db, event.oldEvidence?.ref)) {
    if (!newEvidence.has(row.id) && matcher.statesOld(row.text)) {
      mark(row.id);
    }
  }

  // 2. Everything else must state the old value AND name the key's subject.
  const consider = (row: ChunkRow): void => {
    if (result.marked >= maxMarks || newEvidence.has(row.id) || oldEvidenceIds.has(row.id)) {
      return;
    }
    if (matcher.cites(row.text)) {
      mark(row.id);
    }
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
  consider: (row: ChunkRow) => void,
  result: SupersedeSearchResult,
): Promise<boolean> {
  const table = opts.ftsTable;
  const phrase = ftsPhraseForValue(oldValue);
  if (!table || !phrase) {
    return false;
  }
  let rows: ChunkRow[];
  try {
    const cap = (opts.maxMarks ?? MAX_MARKS_PER_EVENT) * 5;
    // Newest first, deterministically: the cap keeps the most recent.
    rows = db
      .prepare(
        `SELECT c.id AS id, c.text AS text FROM ${table} f JOIN chunks c ON c.id = f.id
          WHERE ${table} MATCH ? ORDER BY c.updated_at DESC, c.id LIMIT ?`,
      )
      .all(phrase, cap) as unknown as ChunkRow[];
  } catch (err) {
    log.debug(`supersede FTS lookup failed, scanning instead: ${String(err)}`);
    return false;
  }
  for (let i = 0; i < rows.length; i++) {
    result.scanned++;
    consider(rows[i]!);
    if (i % 100 === 99) {
      await yieldToEventLoop();
    }
  }
  return true;
}

async function scanChunksWindowed(
  db: DatabaseSync,
  opts: SupersedeSearchOptions,
  consider: (row: ChunkRow) => void,
  result: SupersedeSearchResult,
  maxMarks: number,
): Promise<void> {
  const windowRows = opts.windowRows ?? SCAN_WINDOW_ROWS;
  const maxScan = opts.maxScanRows ?? MAX_SCAN_ROWS;
  // Newest first (highest rowid), so the cap keeps the most recent chunks.
  const page = db.prepare(
    `SELECT rowid AS rid, id, text FROM chunks WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
  );
  let before = Number.MAX_SAFE_INTEGER;
  while (result.scanned < maxScan && result.marked < maxMarks) {
    const rows = page.all(before, windowRows) as unknown as Array<ChunkRow & { rid: number }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      consider(row);
    }
    result.scanned += rows.length;
    before = rows[rows.length - 1]!.rid;
    await yieldToEventLoop();
  }
}

/** True when any chunk carries a supersession mark (cheap; used to size over-fetch). */
export function hasSupersessionMarks(db: DatabaseSync): boolean {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM chunk_supersessions LIMIT 1`).get());
  } catch {
    return false;
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
