import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";

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

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe("migration v78: canonical:changed propagation (PLAN-55 Phase 2)", () => {
  it("is the latest schema version", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(78);
  });

  it("creates chunk_supersessions with its key index and the stale_fact columns", () => {
    const db = openTestDb();
    expect(columns(db, "chunk_supersessions")).toEqual([
      "chunk_id",
      "fact_key",
      "stale_value",
      "fact_id",
      "current_value",
      "created_at",
    ]);
    const indexes = (
      db.prepare(`PRAGMA index_list(chunk_supersessions)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_chunk_supersessions_key");
    expect(columns(db, "dream_briefs")).toContain("stale_fact");
    expect(columns(db, "dream_insights")).toContain("stale_fact");
  });

  it("keys a mark by (chunk, key, stale value)", () => {
    const db = openTestDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO chunk_supersessions (chunk_id, fact_key, stale_value, created_at)
       VALUES (?, ?, ?, 1)`,
    );
    insert.run("c", "k.a", "v");
    insert.run("c", "k.a", "v");
    insert.run("c", "k.a", "w");
    insert.run("c", "k.b", "v");
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM chunk_supersessions`).get() as { n: number }).n,
    ).toBe(3);
  });

  it("is idempotent, and tolerates a database without the dream tables", () => {
    const db = openTestDb();
    expect(() =>
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        ftsTable: "chunks_fts",
        ftsEnabled: false,
      }),
    ).not.toThrow();
    const bare = new DatabaseSync(":memory:");
    bare.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
    const v78 = MIGRATIONS.find((m) => m.version === 78)!;
    expect(runMigrations(bare, [v78])).toMatchObject({ to: 78 });
    expect(columns(bare, "chunk_supersessions")).toContain("stale_value");
  });
});
