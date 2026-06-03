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

describe("migration v16 — SABM relationship belief history", () => {
  it("creates the relationship_belief_history table with the expected columns", () => {
    const db = openTestDb();
    const cols = db.prepare(`PRAGMA table_info(relationship_belief_history)`).all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "relationship_id",
        "action",
        "prev_weight",
        "new_weight",
        "evidence_chunk_ids",
        "valid_from",
        "valid_until",
        "created_at",
      ]),
    );
  });

  it("adds last_reinforced_at to relationships without renaming valid_from/valid_until", () => {
    const db = openTestDb();
    const names = (
      db.prepare(`PRAGMA table_info(relationships)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(names).toContain("last_reinforced_at");
    // The relationship temporal vocabulary stays valid_from/valid_until (NOT the
    // chunks valid_time_* vocabulary). Guard against an accidental rename.
    expect(names).toContain("valid_from");
    expect(names).toContain("valid_until");
    expect(names).not.toContain("valid_time_start");
    expect(names).not.toContain("valid_time_end");
  });

  it("creates the belief-history indexes", () => {
    const db = openTestDb();
    const idx = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relationship_belief_history'`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toEqual(
      expect.arrayContaining(["idx_rel_belief_history_rel", "idx_rel_belief_history_action"]),
    );
  });

  it("is idempotent: re-running migrations is a no-op", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    // Re-running must not throw and the column count stays stable.
    const names = (db.prepare(`PRAGMA table_info(relationships)`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((n) => n === "last_reinforced_at");
    expect(names).toHaveLength(1);
  });

  it("schema version is at least 16 after migrations", () => {
    const db = openTestDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(16);
  });
});
