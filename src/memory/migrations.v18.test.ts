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

describe("migration v18 — construction_rules", () => {
  it("creates construction_rules with the expected columns", () => {
    const db = openTestDb();
    const cols = (
      db.prepare(`PRAGMA table_info(construction_rules)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "rule_text",
        "category",
        "status",
        "source",
        "version",
        "ci95_low",
        "birth_dopamine",
        "birth_cortisol",
        "birth_oxytocin",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("is idempotent and lands schema version >= 18", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(18);
  });
});
