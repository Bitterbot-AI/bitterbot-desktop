/**
 * v63 (PLAN-45 Phase 0): purge the SkillCrystallizer's output and the
 * orphaned execution rows that kept feeding it. The reference node had 572
 * crystallizer/auto chunks minted from 13 skill_executions rows whose four
 * source crystals were deleted a month earlier, plus 76 marketplace_listings
 * rows for crystals that no longer existed.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

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

function insertChunk(db: DatabaseSync, id: string, path: string, parentId: string | null): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       updated_at, created_at, parent_id, origin)
     VALUES (?, ?, 'skills', 0, 0, 'body', ?, 'test', '[]', 1, 1, ?, 'inferred')`,
  ).run(id, path, `h-${id}`, parentId);
}

function insertExecution(db: DatabaseSync, id: string, crystalId: string): void {
  db.prepare(
    `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success)
     VALUES (?, ?, 1, 2, 1)`,
  ).run(id, crystalId);
}

describe("migration v63: crystallizer purge", () => {
  it("deletes crystallizer/auto chunks, orphaned executions and orphaned listings; keeps the rest", () => {
    const db = openTestDb();
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    db.prepare(`UPDATE meta SET value = '62' WHERE key = 'schema_version'`).run();
    db.exec(
      `CREATE TABLE IF NOT EXISTS marketplace_listings (skill_crystal_id TEXT PRIMARY KEY, name TEXT)`,
    );

    insertChunk(db, "live-skill", "skills/live", null);
    insertChunk(db, "auto-1", "crystallizer/auto", "deleted-parent");
    insertChunk(db, "auto-2", "crystallizer/auto", "live-skill");
    insertExecution(db, "e-live", "live-skill");
    insertExecution(db, "e-orphan", "deleted-parent");
    insertExecution(db, "e-auto", "auto-1");
    db.prepare(`INSERT INTO marketplace_listings VALUES ('live-skill', 'live')`).run();
    db.prepare(`INSERT INTO marketplace_listings VALUES ('deleted-parent', 'gone')`).run();

    runMigrations(db);

    const chunkIds = (
      db.prepare(`SELECT id FROM chunks ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(chunkIds).toEqual(["live-skill"]);
    const execIds = (
      db.prepare(`SELECT id FROM skill_executions ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(execIds).toEqual(["e-live"]);
    const listingIds = (
      db.prepare(`SELECT skill_crystal_id AS id FROM marketplace_listings`).all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    expect(listingIds).toEqual(["live-skill"]);
    expect(
      (db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string })
        .value,
    ).toBe(String(LATEST_SCHEMA_VERSION));
  });

  it("purges FTS rows when FTS is enabled and leaves unrelated skill chunks alone", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });
    db.prepare(`UPDATE meta SET value = '62' WHERE key = 'schema_version'`).run();
    insertChunk(db, "live-skill", "skills/live", null);
    insertChunk(db, "auto-1", "crystallizer/auto", "live-skill");
    // Same path but not the crystallizer's writer signature: untouched.
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
         updated_at, created_at, origin)
       VALUES ('authored', 'crystallizer/auto', 'memory', 0, 0, 'body', 'h-a', 'test', '[]', 1, 1, 'user')`,
    ).run();
    for (const id of ["live-skill", "auto-1", "authored"]) {
      db.prepare(`INSERT INTO chunks_fts (id, text) VALUES (?, 'body')`).run(id);
    }
    runMigrations(db);
    const chunkIds = (
      db.prepare(`SELECT id FROM chunks ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(chunkIds).toEqual(["authored", "live-skill"]);
    const ftsIds = (
      db.prepare(`SELECT id FROM chunks_fts ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ftsIds).toEqual(["authored", "live-skill"]);
  });

  it("is idempotent and safe on a database with no marketplace table", () => {
    const db = openTestDb();
    db.prepare(`UPDATE meta SET value = '62' WHERE key = 'schema_version'`).run();
    insertChunk(db, "live-skill", "skills/live", null);
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get()).toEqual(
      expect.objectContaining({ n: 1 }),
    );
  });
});
