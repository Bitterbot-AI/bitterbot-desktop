/**
 * PLAN-46 Phase 1 (D-4): migration v67 drops the orphaned skill_text_history
 * table (zero code references — no writer, reader, or CREATE). Verifies the
 * drop and that a DB without the table migrates cleanly (idempotent).
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

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !==
    undefined
  );
}

describe("migration v67: drop orphaned skill_text_history (PLAN-46 Phase 1)", () => {
  it("drops the table when present", () => {
    const db = openTestDb();
    db.exec(`CREATE TABLE IF NOT EXISTS skill_text_history (id TEXT PRIMARY KEY, text TEXT)`);
    expect(hasTable(db, "skill_text_history")).toBe(true);
    // Simulate a pre-v67 node (the live DB was at v66) so v67 is pending.
    db.prepare(`UPDATE meta SET value = '66' WHERE key = 'schema_version'`).run();
    const res = runMigrations(db);
    expect(res.to).toBe(LATEST_SCHEMA_VERSION);
    expect(hasTable(db, "skill_text_history")).toBe(false);
    db.close();
  });

  it("is a no-op when the table is already absent (idempotent)", () => {
    const db = openTestDb();
    expect(hasTable(db, "skill_text_history")).toBe(false);
    expect(() => runMigrations(db)).not.toThrow();
    expect(hasTable(db, "skill_text_history")).toBe(false);
    db.close();
  });
});
