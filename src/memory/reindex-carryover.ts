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
 *
 * Chunks are not the only thing in the file. `carryOverAuxiliaryTables` at the
 * bottom carries every table the rebuild does not own.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type Lifecycle, setChunkLifecycle } from "./chunk-writer.js";
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
  const dropFts = ftsTable ? to.prepare(`DELETE FROM ${ftsTable} WHERE id = ?`) : null;
  for (const row of demoted) {
    try {
      setChunkLifecycle(to, asText(row.id), {
        lifecycle: asText(row.lifecycle) as Lifecycle,
        parentId: (row.parent_id ?? null) as string | null,
        hygieneDone: true,
      });
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

export type AuxiliaryCarryOverResult = {
  tables: number;
  rows: number;
  created: number;
  /** Virtual tables left behind that the caller did not declare as rebuilt. */
  unclaimedVirtualTables: string[];
};

/**
 * Meta keys that hold a cursor over chunk ROWIDS (canonical promotion,
 * relationship mining). A rebuild renumbers the chunks table, so a carried
 * cursor would point past every row and stall its lane. Dropping the key
 * restarts the lane from the beginning, which both are written to tolerate.
 */
const ROWID_CURSOR_META_PATTERN = "%\\_cursor";

const ATTACH_ALIAS = "reindex_prev";

const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
type XInfoRow = { name: string; type: string; pk: number; hidden: number };

/**
 * Carry every table the rebuild does not own across a full reindex.
 *
 * WHY (2026-10-01): `runSafeReindex` builds the new index in an EMPTY database
 * and swaps it in. The chunk carry-over above saved the crystals, but the
 * memory database is not only an index. Canonical facts, the knowledge graph,
 * dream history, user preferences, curiosity state, Circles membership and
 * sender keys, bounty and payment ledgers all live in the same file, and all
 * of them were dropped by the swap. A provider change on 2026-09-30 left a
 * 113-table database with 9 populated tables.
 *
 * The rule is by exclusion, so a table added next month is carried without
 * anyone remembering this file: every ordinary table in the previous database
 * is copied unless the rebuild owns it (`rebuiltTables`), it is a virtual
 * table or one of its shadow tables (search indexes, rebuilt from chunks), or
 * it is SQLite's own. The previous database is the source of truth for these
 * tables, so anything the fresh schema seeded into them is replaced. Tables
 * the fresh schema does not have yet (created lazily by a subsystem) are
 * created from the previous database's own DDL, with their indexes.
 *
 * Throws on any failure and leaves `to` unchanged. The caller must not swap.
 */
export function carryOverAuxiliaryTables(params: {
  to: DatabaseSync;
  /** Path of the database being replaced. Attached read-only in effect: only SELECTed. */
  fromPath: string;
  rebuiltTables: string[];
  /** Virtual tables the caller rebuilds itself (the search indexes over chunks). */
  rebuiltVirtualTables?: string[];
  /** The index-meta key the caller writes itself after the rebuild. */
  indexMetaKey: string;
}): AuxiliaryCarryOverResult {
  const { to } = params;
  const prev = ATTACH_ALIAS;
  const result: AuxiliaryCarryOverResult = {
    tables: 0,
    rows: 0,
    created: 0,
    unclaimedVirtualTables: [],
  };

  to.prepare(`ATTACH DATABASE ? AS ${prev}`).run(params.fromPath);
  let inTransaction = false;
  try {
    const master = to
      .prepare(`SELECT type, name, tbl_name, sql FROM ${prev}.sqlite_master`)
      .all() as unknown as MasterRow[];
    const virtualTables = master
      .filter((r) => r.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? ""))
      .map((r) => r.name);
    const isVirtualOrShadow = (name: string): boolean =>
      virtualTables.some((v) => name === v || name.startsWith(`${v}_`));
    // A virtual table cannot be copied generically (its module may not even be
    // loaded here). The search indexes are rebuilt by the caller; any other one
    // is a gap someone has to close on purpose, so say so instead of dropping it
    // quietly.
    const claimed = new Set(params.rebuiltVirtualTables ?? []);
    result.unclaimedVirtualTables = virtualTables.filter((v) => !claimed.has(v));
    if (result.unclaimedVirtualTables.length > 0) {
      log.warn(
        `reindex carry-over: virtual table(s) not carried and not rebuilt: ` +
          result.unclaimedVirtualTables.join(", "),
      );
    }
    const owned = new Set([...params.rebuiltTables, "meta"]);
    const tables = master.filter(
      (r) =>
        r.type === "table" &&
        !r.name.startsWith("sqlite_") &&
        !owned.has(r.name) &&
        !isVirtualOrShadow(r.name),
    );
    const existing = new Set(
      (
        to.prepare(`SELECT name FROM main.sqlite_master WHERE type = 'table'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    const visibleColumns = (schema: string, table: string): XInfoRow[] =>
      (
        to
          .prepare(`PRAGMA ${schema}.table_xinfo(${quoteIdent(table)})`)
          .all() as unknown as XInfoRow[]
      ).filter((c) => c.hidden === 0);
    const count = (schema: string, table: string): number =>
      (
        to.prepare(`SELECT COUNT(*) AS c FROM ${schema}.${quoteIdent(table)}`).get() as {
          c: number;
        }
      ).c;

    to.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    // Parents and children are copied in catalogue order, not dependency order.
    to.exec("PRAGMA defer_foreign_keys = ON");

    for (const table of tables) {
      const name = quoteIdent(table.name);
      if (!existing.has(table.name)) {
        if (!table.sql) {
          throw new Error(`no DDL recorded for table ${table.name}`);
        }
        to.exec(table.sql);
        for (const dependent of master) {
          if (dependent.tbl_name !== table.name || !dependent.sql) continue;
          if (dependent.type === "index" || dependent.type === "trigger") {
            to.exec(dependent.sql);
          }
        }
        result.created++;
      }

      const prevCols = visibleColumns(prev, table.name);
      const available = new Set(visibleColumns("main", table.name).map((c) => c.name));
      const cols = prevCols.filter((c) => available.has(c.name)).map((c) => quoteIdent(c.name));
      if (cols.length === 0) {
        throw new Error(`table ${table.name} shares no columns with the rebuilt schema`);
      }
      // Keep implicit rowids stable where the table has no declared integer
      // key of its own (an INTEGER PRIMARY KEY column already IS the rowid).
      const pk = prevCols.filter((c) => c.pk > 0);
      const hasRowidAlias = pk.length === 1 && pk[0]?.type.toUpperCase() === "INTEGER";
      const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(table.sql ?? "");
      const shadowsRowid = prevCols.some((c) =>
        ["rowid", "oid", "_rowid_"].includes(c.name.toLowerCase()),
      );
      const list = hasRowidAlias || withoutRowid || shadowsRowid ? cols : ["rowid", ...cols];

      to.exec(`DELETE FROM main.${name}`);
      to.exec(
        `INSERT INTO main.${name} (${list.join(", ")}) SELECT ${list.join(", ")} FROM ${prev}.${name}`,
      );
      const copied = count("main", table.name);
      const expected = count(prev, table.name);
      if (copied !== expected) {
        throw new Error(`table ${table.name}: copied ${copied} of ${expected} row(s)`);
      }
      result.tables++;
      result.rows += copied;
    }

    // meta: every key survives except the index meta (the caller writes the new
    // one) and the rowid cursors (see ROWID_CURSOR_META_PATTERN).
    to.prepare(
      `INSERT OR REPLACE INTO main.meta (key, value)
       SELECT key, value FROM ${prev}.meta WHERE key <> ? AND key NOT LIKE ? ESCAPE '\\'`,
    ).run(params.indexMetaKey, ROWID_CURSOR_META_PATTERN);

    // AUTOINCREMENT high-water marks, so ids of deleted rows are not reissued.
    const hasSequence = (schema: string): boolean =>
      Boolean(
        to.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name = 'sqlite_sequence'`).get(),
      );
    if (hasSequence(prev) && hasSequence("main")) {
      const copiedNames = new Set(tables.map((t) => t.name));
      const sequences = to.prepare(`SELECT name, seq FROM ${prev}.sqlite_sequence`).all() as Array<{
        name: string;
        seq: number;
      }>;
      for (const { name, seq } of sequences) {
        if (!copiedNames.has(name)) continue;
        const updated = to
          .prepare(`UPDATE main.sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`)
          .run(seq, name);
        if (updated.changes === 0) {
          to.prepare(`INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)`).run(name, seq);
        }
      }
    }

    to.exec("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) {
      try {
        to.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    try {
      to.exec(`DETACH DATABASE ${prev}`);
    } catch {
      /* ignore */
    }
    throw new Error(`reindex carry-over of non-index tables failed: ${String(err)}`, {
      cause: err,
    });
  }
  try {
    to.exec(`DETACH DATABASE ${prev}`);
  } catch (err) {
    // The copy is committed; the caller closes this connection before the swap.
    log.debug(`detach after carry-over failed: ${String(err)}`);
  }

  log.info(
    `reindex carry-over: preserved ${result.rows} row(s) in ${result.tables} non-index table(s)` +
      (result.created > 0 ? ` (${result.created} created from the previous schema)` : ""),
  );
  return result;
}
