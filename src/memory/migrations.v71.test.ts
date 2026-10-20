/**
 * Migration v71 (circles security pass): presence high-water mark (M3) and the
 * removal notice's named member (M2).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("migration v71: circles replay + removal columns", () => {
  it("adds both columns idempotently", () => {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(71);
    expect(columns(db, "circle_members")).toContain("last_presence_ts");
    expect(columns(db, "circle_messages")).toContain("system_target");
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run("70");
    expect(() => runMigrations(db)).not.toThrow();
  });
});
