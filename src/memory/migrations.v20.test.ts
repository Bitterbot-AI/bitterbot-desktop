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

function tables(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

describe("migration v20 — Aubaine group-buy coordination tables", () => {
  it("creates the five coordination tables", () => {
    const present = tables(openTestDb());
    for (const t of [
      "group_buy_offers",
      "group_buy_intents",
      "group_buy_syndicates",
      "group_buy_members",
      "group_buy_settlements",
    ]) {
      expect(present.has(t)).toBe(true);
    }
  });

  it("group_buy_intents carries the signed mandate column", () => {
    const cols = (
      openTestDb().prepare(`PRAGMA table_info(group_buy_intents)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("mandate_json");
    expect(cols).toContain("sku_canonical");
  });

  it("is idempotent and lands schema version >= 20", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(20);
  });
});
