/**
 * Carry non-file-derived chunks across a full reindex.
 *
 * WHY (2026-08-12, PLAN-40 phase adversarial pass): a full reindex rebuilds the
 * index FROM FILES ONLY — `runSafeReindex` populates a fresh temp DB by walking
 * memory/session/skill files and then swaps it in. Every chunk that no file
 * produces was therefore destroyed:
 *
 *   - extracted fact crystals (`fact_*`) and the canonical material behind them
 *   - scratch notes, handover crystals, peer imports
 *   - dream insight chunks and PLAN-40 hygiene merge summaries
 *
 * Verified with a probe: insert a scratch note, run one `sync({force:true})`,
 * and the row is gone. This is not an exotic path — it fires on `force`, on an
 * embedding model or provider change, on a chunking-settings change, and on an
 * API-KEY ROTATION (`providerKey`). Rotating a key silently deleted the agent's
 * crystallized memory while leaving the file-derived chunks intact, so the index
 * still looked healthy.
 *
 * The rule is exact rather than heuristic: after the rebuild, any chunk id in
 * the old index that the rebuild did NOT reproduce is carried over verbatim.
 * File-derived chunks are reproduced (ids are content-derived), so they are not
 * touched; everything else survives. Demotion is respected — a carried chunk
 * that the hygiene merge consolidated stays out of the search indexes.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/reindex-carryover");

/** Lifecycles that must never be re-indexed into the search surfaces. */
const DEMOTED_LIFECYCLES = new Set(["consolidated", "archived"]);

export type CarryOverResult = { carried: number; ftsIndexed: number };
export type ChunkSnapshot = { cols: string[]; rows: Array<Record<string, unknown>> };

/** Row values arrive as `unknown`; only real strings are meaningful here. */
const asText = (value: unknown): string => (typeof value === "string" ? value : "");

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Read every chunk row up front. Needed by the in-place reindex path, which
 * wipes the SAME database it rebuilds into — by the time the rebuild finishes
 * there is no "previous index" left to copy from.
 */
export function readChunkSnapshot(db: DatabaseSync): ChunkSnapshot | null {
  try {
    const cols = columnNames(db, "chunks");
    if (!cols.includes("id")) return null;
    const rows = db.prepare(`SELECT ${cols.join(", ")} FROM chunks`).all() as Array<
      Record<string, unknown>
    >;
    return { cols, rows };
  } catch (err) {
    log.debug(`chunk snapshot unavailable: ${String(err)}`);
    return null;
  }
}

/**
 * Restore `consolidated`/`archived` state onto chunks the rebuild re-created
 * from their source file, and take them back out of the keyword index.
 */
function reapplyDemotions(
  snapshot: ChunkSnapshot,
  to: DatabaseSync,
  existing: Set<string>,
  ftsTable: string | null,
): number {
  const demoted = snapshot.rows.filter(
    (row) => existing.has(asText(row.id)) && DEMOTED_LIFECYCLES.has(asText(row.lifecycle)),
  );
  if (demoted.length === 0) return 0;
  let applied = 0;
  const update = to.prepare(
    `UPDATE chunks SET lifecycle = ?, parent_id = ?, hygiene_done = 1 WHERE id = ?`,
  );
  const dropFts = ftsTable ? to.prepare(`DELETE FROM ${ftsTable} WHERE id = ?`) : null;
  for (const row of demoted) {
    try {
      update.run(asText(row.lifecycle), (row.parent_id ?? null) as string | null, asText(row.id));
      dropFts?.run(asText(row.id));
      applied++;
    } catch (err) {
      log.debug(`re-demotion failed for ${asText(row.id)}: ${String(err)}`);
    }
  }
  return applied;
}

/**
 * Copy every chunk row present in `from` but absent from `to`, plus its FTS row
 * when the chunk is still retrieval-eligible.
 *
 * Columns are intersected between the two schemas so this keeps working when a
 * migration adds a column on one side; unknown columns are simply not copied.
 */
export function carryOverNonFileChunks(params: {
  from?: DatabaseSync;
  snapshot?: ChunkSnapshot | null;
  to: DatabaseSync;
  ftsTable?: string | null;
}): CarryOverResult {
  const { to } = params;
  const result: CarryOverResult = { carried: 0, ftsIndexed: 0 };

  const snapshot = params.snapshot ?? (params.from ? readChunkSnapshot(params.from) : null);
  if (!snapshot || snapshot.rows.length === 0) {
    return result;
  }

  let cols: string[];
  try {
    const available = new Set(columnNames(to, "chunks"));
    cols = snapshot.cols.filter((c) => available.has(c));
  } catch (err) {
    log.warn(`reindex carry-over skipped (schema unreadable): ${String(err)}`);
    return result;
  }
  if (cols.length === 0 || !cols.includes("id")) {
    return result;
  }

  let existing: Set<string>;
  try {
    existing = new Set(
      (to.prepare(`SELECT id FROM chunks`).all() as Array<{ id: string }>).map((r) => r.id),
    );
  } catch (err) {
    log.warn(`reindex carry-over skipped (rebuilt index unreadable): ${String(err)}`);
    return result;
  }

  // Demotions are derived state that the rebuild cannot know about: a member
  // the hygiene merge consolidated is re-derived from its file as a fresh
  // `generated` chunk, silently undoing the merge for every file-backed member.
  // Re-apply the demotion to ids the rebuild DID reproduce.
  const reDemoted = reapplyDemotions(snapshot, to, existing, params.ftsTable ?? null);
  if (reDemoted > 0) {
    log.info(`reindex carry-over: re-applied ${reDemoted} demotion(s) the rebuild had cleared`);
  }

  const missing = snapshot.rows.filter((row) => !existing.has(asText(row.id)));
  if (missing.length === 0) {
    return result;
  }

  const insert = to.prepare(
    `INSERT OR IGNORE INTO chunks (${cols.join(", ")})
     VALUES (${cols.map(() => "?").join(", ")})`,
  );
  const ftsTable = params.ftsTable;
  const ftsInsert = ftsTable
    ? to.prepare(
        `INSERT INTO ${ftsTable} (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
    : null;

  to.exec("BEGIN");
  try {
    for (const row of missing) {
      insert.run(...cols.map((c) => (row[c] ?? null) as never));
      result.carried++;
      if (!ftsInsert) continue;
      const lifecycle = asText(row.lifecycle) || "generated";
      if (DEMOTED_LIFECYCLES.has(lifecycle)) {
        // Demoted by the hygiene merge (or compression): the whole point is
        // that it is NOT in the retrieval surface. Carrying the row forward
        // without re-indexing it preserves that.
        continue;
      }
      const text = row.text;
      if (typeof text !== "string" || text.length === 0) continue;
      ftsInsert.run(
        text,
        asText(row.id),
        asText(row.path),
        asText(row.source),
        asText(row.model),
        Number(row.start_line ?? 0),
        Number(row.end_line ?? 0),
      );
      result.ftsIndexed++;
    }
    to.exec("COMMIT");
  } catch (err) {
    try {
      to.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    log.warn(`reindex carry-over failed (rolled back): ${String(err)}`);
    return { carried: 0, ftsIndexed: 0 };
  }

  log.info(
    `reindex carry-over: preserved ${result.carried} non-file chunk(s) ` +
      `(${result.ftsIndexed} re-indexed, ${result.carried - result.ftsIndexed} kept demoted)`,
  );
  return result;
}
