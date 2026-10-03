/**
 * Migration v70: partial indexes for the two maintenance-tick queries that
 * full-scanned `chunks` for rows that do not exist (2026-10-03 soak: ~5 s of
 * cold synchronous I/O each, every 30 minutes, on the gateway loop).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

function openMigratedDb(): DatabaseSync {
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

function plan(db: DatabaseSync, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join(" | ");
}

describe("migration v70: maintenance-tick partial indexes", () => {
  it("is the latest version and creates both indexes idempotently", () => {
    const db = openMigratedDb();
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chunks'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain("idx_chunks_curiosity_pending");
    expect(names).toContain("idx_chunks_governance_ttl");
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run("69");
    expect(() => runMigrations(db)).not.toThrow();
  });

  it("serves the pending-curiosity query from the index instead of scanning the table", () => {
    const db = openMigratedDb();
    const detail = plan(
      db,
      `SELECT id, embedding FROM chunks
       WHERE curiosity_reward IS NULL
         AND COALESCE(lifecycle_state, 'active') = 'active'
         AND embedding IS NOT NULL AND embedding != '[]'
       LIMIT 50`,
    );
    expect(detail).toContain("idx_chunks_curiosity_pending");
  });

  it("serves the governance TTL query from the index instead of scanning the table", () => {
    const db = openMigratedDb();
    const detail = plan(
      db,
      `SELECT id, governance_json, created_at FROM chunks
       WHERE COALESCE(lifecycle, 'generated') NOT IN ('expired', 'frozen')
         AND governance_json LIKE '%ttl%'`,
    );
    expect(detail).toContain("idx_chunks_governance_ttl");
  });
});
