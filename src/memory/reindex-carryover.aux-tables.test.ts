/**
 * A full reindex must carry every table it does not own.
 *
 * Found 2026-10-01. The memory database holds far more than the search index:
 * canonical facts, the knowledge graph, dream history, user preferences,
 * Circles keys, payment ledgers. `runSafeReindex` rebuilt into an empty
 * database and swapped it in, so one embedding-provider change emptied all of
 * them. These tests pin the copy itself; `manager.reindex-preserves-tables`
 * pins that the reindex actually calls it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carryOverAuxiliaryTables } from "./reindex-carryover.js";
import { requireNodeSqlite } from "./sqlite.js";

const INDEX_META_KEY = "memory_index_meta_v1";
const REBUILT = ["files", "chunks", "embedding_cache"];

let root: string;
let prevPath: string;
let prev: DatabaseSync;
let next: DatabaseSync;

const open = (file: string): DatabaseSync => {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(file);
  db.prepare("PRAGMA journal_mode = WAL").get();
  // Fixture speed only: every autocommit statement would otherwise fsync.
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
};

/** The tables both the previous and the freshly rebuilt database have. */
const baseSchema = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT);
  CREATE TABLE chunks (id TEXT PRIMARY KEY, text TEXT);
  CREATE TABLE embedding_cache (hash TEXT PRIMARY KEY, embedding BLOB);
  CREATE VIRTUAL TABLE chunks_fts USING fts5(text, id UNINDEXED);
  CREATE TABLE canonical_facts (id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT);
  CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES entities(id),
    target_id TEXT NOT NULL REFERENCES entities(id)
  );
  CREATE TABLE dream_cycles (id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT);
  CREATE TABLE audit_log (event TEXT, at INTEGER);
`;

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

const run = () =>
  carryOverAuxiliaryTables({
    to: next,
    fromPath: prevPath,
    rebuiltTables: REBUILT,
    rebuiltVirtualTables: ["chunks_fts"],
    indexMetaKey: INDEX_META_KEY,
  });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bitterbot-aux-carry-"));
  prevPath = path.join(root, "prev.sqlite");
  prev = open(prevPath);
  next = open(path.join(root, "next.sqlite"));
  prev.exec(baseSchema);
  next.exec(baseSchema);

  prev.exec(`
    INSERT INTO meta VALUES ('${INDEX_META_KEY}', '{"provider":"openai"}');
    INSERT INTO meta VALUES ('schema_version', '69');
    INSERT INTO meta VALUES ('seed_migration_done', 'true');
    INSERT INTO meta VALUES ('canonical_promotion_cursor', '112402');
    INSERT INTO files VALUES ('old.md', 'h-old');
    INSERT INTO chunks VALUES ('c-old', 'old chunk');
    INSERT INTO chunks_fts (text, id) VALUES ('old chunk', 'c-old');
    INSERT INTO canonical_facts VALUES ('f1', 'user.name', 'Ada');
    INSERT INTO canonical_facts VALUES ('f2', 'user.city', 'Lisbon');
    INSERT INTO entities VALUES ('e1', 'Ada');
    INSERT INTO entities VALUES ('e2', 'Lisbon');
    INSERT INTO relationships VALUES ('r1', 'e1', 'e2');
    INSERT INTO dream_cycles (mode) VALUES ('replay'), ('compression'), ('replay');
    DELETE FROM dream_cycles WHERE id = 3;
    INSERT INTO audit_log VALUES ('first', 1), ('second', 2), ('third', 3);
    DELETE FROM audit_log WHERE event = 'second';
  `);
  next.exec(`
    INSERT INTO meta VALUES ('schema_version', '69');
    INSERT INTO files VALUES ('new.md', 'h-new');
    INSERT INTO chunks VALUES ('c-new', 'rebuilt chunk');
    INSERT INTO chunks_fts (text, id) VALUES ('rebuilt chunk', 'c-new');
  `);
});

afterEach(async () => {
  for (const db of [prev, next]) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

describe("carryOverAuxiliaryTables", () => {
  it("copies every table the rebuild does not own", () => {
    const result = run();

    expect(count(next, "canonical_facts")).toBe(2);
    expect(count(next, "entities")).toBe(2);
    expect(count(next, "relationships")).toBe(1);
    expect(count(next, "dream_cycles")).toBe(2);
    expect(count(next, "audit_log")).toBe(2);
    expect(result.tables).toBe(5);
    expect(result.rows).toBe(9);
    expect(result.created).toBe(0);
  });

  it("leaves the rebuilt index tables and the search index alone", () => {
    run();

    expect(next.prepare(`SELECT path FROM files`).all()).toEqual([{ path: "new.md" }]);
    expect(next.prepare(`SELECT id FROM chunks`).all()).toEqual([{ id: "c-new" }]);
    expect(next.prepare(`SELECT id FROM chunks_fts`).all()).toEqual([{ id: "c-new" }]);
  });

  it("creates a table the fresh schema does not have, with its indexes", () => {
    // Subsystems create some tables lazily, after the base schema. The live
    // database had 20 such tables the rebuilt one lacked.
    prev.exec(`
      CREATE TABLE user_preferences (id TEXT PRIMARY KEY, kind TEXT, body TEXT);
      CREATE INDEX idx_user_preferences_kind ON user_preferences(kind);
      INSERT INTO user_preferences VALUES ('p1', 'directive', 'no em-dashes');
    `);

    const result = run();

    expect(result.created).toBe(1);
    expect(next.prepare(`SELECT body FROM user_preferences`).all()).toEqual([
      { body: "no em-dashes" },
    ]);
    const index = next
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_preferences' AND sql IS NOT NULL`,
      )
      .all();
    expect(index).toEqual([{ name: "idx_user_preferences_kind" }]);
  });

  it("replaces rows the fresh schema seeded: the previous database is the truth", () => {
    next.exec(`INSERT INTO canonical_facts VALUES ('seed', 'user.name', 'placeholder')`);

    run();

    expect(next.prepare(`SELECT id FROM canonical_facts ORDER BY id`).all()).toEqual([
      { id: "f1" },
      { id: "f2" },
    ]);
  });

  it("carries meta keys except the index meta and the chunk-rowid cursors", () => {
    run();

    const meta = Object.fromEntries(
      (
        next.prepare(`SELECT key, value FROM meta`).all() as Array<{ key: string; value: string }>
      ).map((r) => [r.key, r.value]),
    );
    expect(meta.seed_migration_done).toBe("true");
    expect(meta.schema_version).toBe("69");
    // The caller writes the new index meta; the old provider must not come back.
    expect(meta[INDEX_META_KEY]).toBeUndefined();
    // Chunk rowids are renumbered by the rebuild; an old cursor would stall its lane.
    expect(meta.canonical_promotion_cursor).toBeUndefined();
  });

  it("keeps implicit rowids and AUTOINCREMENT high-water marks", () => {
    run();

    expect(next.prepare(`SELECT rowid, event FROM audit_log ORDER BY rowid`).all()).toEqual([
      { rowid: 1, event: "first" },
      { rowid: 3, event: "third" },
    ]);
    // id 3 was issued and deleted; it must not be issued again.
    next.exec(`INSERT INTO dream_cycles (mode) VALUES ('simulation')`);
    const newest = next.prepare(`SELECT MAX(id) AS id FROM dream_cycles`).get() as { id: number };
    expect(newest.id).toBe(4);
  });

  it("tolerates a column the rebuilt schema does not have", () => {
    prev.exec(`ALTER TABLE canonical_facts ADD COLUMN retired_note TEXT`);
    prev.exec(`UPDATE canonical_facts SET retired_note = 'x'`);

    run();

    expect(count(next, "canonical_facts")).toBe(2);
  });

  it("throws and changes nothing when a table cannot be copied", () => {
    // Same table name, incompatible shape: nothing in common to copy.
    next.exec(`DROP TABLE audit_log; CREATE TABLE audit_log (unrelated TEXT)`);
    next.exec(`INSERT INTO canonical_facts VALUES ('seed', 'k', 'v')`);

    expect(run).toThrow(/carry-over of non-index tables failed/);

    // Rolled back: the earlier tables were not half-copied.
    expect(next.prepare(`SELECT id FROM canonical_facts`).all()).toEqual([{ id: "seed" }]);
    expect(count(next, "entities")).toBe(0);
    // And the previous database is untouched and still usable.
    expect(count(prev, "canonical_facts")).toBe(2);
  });

  it("reports a virtual table nobody claimed instead of dropping it silently", () => {
    expect(run().unclaimedVirtualTables).toEqual([]);

    // A future feature adds its own search index. Nothing rebuilds it and it
    // cannot be copied generically, so the result has to name it.
    prev.exec(`CREATE VIRTUAL TABLE facts_fts USING fts5(body)`);
    prev.exec(`INSERT INTO facts_fts (body) VALUES ('x')`);

    expect(run().unclaimedVirtualTables).toEqual(["facts_fts"]);
  });

  it("copies a table that has a column of its own named rowid", () => {
    prev.exec(`CREATE TABLE odd (rowid TEXT, v TEXT); INSERT INTO odd VALUES ('a', 'b')`);

    run();

    expect(next.prepare(`SELECT rowid, v FROM odd`).all()).toEqual([{ rowid: "a", v: "b" }]);
  });

  it("does not modify the previous database", () => {
    run();

    expect(count(prev, "canonical_facts")).toBe(2);
    expect(count(prev, "chunks")).toBe(1);
    expect(
      (
        prev.prepare(`SELECT value FROM meta WHERE key = 'canonical_promotion_cursor'`).get() as {
          value: string;
        }
      ).value,
    ).toBe("112402");
  });
});
