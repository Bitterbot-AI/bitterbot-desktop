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

describe("migration v15 — interceptor_strikes", () => {
  it("creates the interceptor_strikes table with the expected columns", () => {
    const db = openTestDb();
    const cols = db.prepare(`PRAGMA table_info(interceptor_strikes)`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "interceptor_id",
        "strikes",
        "disabled",
        "last_failure_ts",
        "last_failure_reason",
      ]),
    );
  });

  it("creates the idx_interceptor_strikes_disabled index", () => {
    const db = openTestDb();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='interceptor_strikes'`,
      )
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["idx_interceptor_strikes_disabled"]),
    );
  });

  it("schema version is at least 15 after migrations", () => {
    const db = openTestDb();
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(15);
  });
});
