/**
 * v58 (PLAN-40 Phase 0): dream-utility substrate. Verifies the new tables/
 * columns, the mutation_queue drop (writers-only, no reader — evaluation
 * E9), and the legacy backfill of funnel rows for pre-plan promoted insight
 * chunks.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  return db;
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe("migration v58: dream-utility substrate", () => {
  it("creates tables/columns, drops mutation_queue, backfills legacy funnel rows", () => {
    const db = openTestDb();
    // Rewind to 57 and recreate the pre-58 world: a mutation_queue with a
    // row, and a promoted insight chunk that must receive a legacy funnel row.
    db.exec(`DROP TABLE IF EXISTS dream_utility; DROP TABLE IF EXISTS dream_briefs;`);
    db.prepare(`UPDATE meta SET value = '57' WHERE key = 'schema_version'`).run();
    db.exec(`CREATE TABLE IF NOT EXISTS mutation_queue (id TEXT PRIMARY KEY, payload TEXT)`);
    db.exec(`INSERT INTO mutation_queue VALUES ('m1', '{}')`);
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         origin, semantic_type, created_at, updated_at)
       VALUES ('dream_insight_x', 'dream/promoted', 'memory', 0, 0, 'insight', 'hx', 'm', '[]',
         'dream', 'insight', 1000, 1000)`,
    ).run();

    const result = runMigrations(db);
    expect(result.to).toBe(LATEST_SCHEMA_VERSION);

    const tables = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
    expect(tables.has("dream_utility")).toBe(true);
    expect(tables.has("dream_briefs")).toBe(true);
    expect(tables.has("mutation_queue")).toBe(false);

    expect(columns(db, "chunks")).toContain("hygiene_done");
    expect(columns(db, "skill_executions")).toEqual(
      expect.arrayContaining(["tool_name", "recorded_by"]),
    );
    expect(columns(db, "canonical_facts")).toEqual(
      expect.arrayContaining(["staleness_asked_count", "last_staleness_ask_at"]),
    );

    const legacy = db
      .prepare(`SELECT lane, artifact_id FROM dream_utility WHERE artifact_id='dream_insight_x'`)
      .get() as { lane: string; artifact_id: string };
    expect(legacy.lane).toBe("legacy");
  });

  it("is idempotent — re-running against a migrated DB changes nothing", () => {
    const db = openTestDb();
    db.prepare(`UPDATE meta SET value = '57' WHERE key = 'schema_version'`).run();
    runMigrations(db);
    const before = (db.prepare(`SELECT COUNT(*) AS c FROM dream_utility`).get() as { c: number }).c;
    db.prepare(`UPDATE meta SET value = '57' WHERE key = 'schema_version'`).run();
    runMigrations(db);
    const after = (db.prepare(`SELECT COUNT(*) AS c FROM dream_utility`).get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
