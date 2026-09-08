/**
 * PLAN-46 dead-code pass: migration v68 drops the empty multi-perspective
 * embedding columns (embedding_procedural/causal/entity) from chunks.
 */
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
  return db;
}

function chunkCols(db: DatabaseSync): string[] {
  return (db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("migration v68: drop dead perspective embedding columns", () => {
  it("leaves chunks without the three perspective columns after a full migrate", () => {
    const db = openTestDb();
    runMigrations(db);
    const cols = chunkCols(db);
    for (const c of ["embedding_procedural", "embedding_causal", "embedding_entity"]) {
      expect(cols).not.toContain(c);
    }
    // The live semantic embedding column is untouched.
    expect(cols).toContain("embedding");
    db.close();
  });

  it("is idempotent — dropping again when already absent does not throw", () => {
    const db = openTestDb();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
