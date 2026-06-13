import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
  return db;
}

describe("migration v19 — graph abstraction parent pointer", () => {
  it("adds parent_entity_id to entities", () => {
    const db = openTestDb();
    const cols = (db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("parent_entity_id");
  });

  it("is idempotent and lands schema version >= 19", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(19);
  });
});
