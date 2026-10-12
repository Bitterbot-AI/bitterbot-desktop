import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { LATEST_SCHEMA_VERSION } from "./migrations.js";

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

describe("migration v76 — memory_suppressions (PLAN-55 Phase 0)", () => {
  it("is the latest schema version", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(76);
  });

  it("creates memory_suppressions with the documented columns and indexes", () => {
    const db = openTestDb();
    const cols = (
      db.prepare(`PRAGMA table_info(memory_suppressions)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(["id", "kind", "hash", "created_at", "reason", "actor", "text"]);
    const indexes = (
      db.prepare(`PRAGMA index_list(memory_suppressions)`).all() as Array<{
        name: string;
        unique: number;
      }>
    ).map((i) => [i.name, i.unique]);
    expect(indexes).toEqual(
      expect.arrayContaining([
        ["idx_memory_suppressions_kind_hash", 1],
        ["idx_memory_suppressions_kind", 0],
      ]),
    );
  });

  it("enforces one row per (kind, hash) and defaults actor to owner", () => {
    const db = openTestDb();
    const ins = db.prepare(
      `INSERT INTO memory_suppressions (id, kind, hash, created_at) VALUES (?, ?, ?, 1)`,
    );
    ins.run("a", "chunk_hash", "h");
    expect(() => ins.run("b", "chunk_hash", "h")).toThrow();
    ins.run("c", "fact_key_value", "h"); // another kind is another row
    const row = db.prepare(`SELECT actor FROM memory_suppressions WHERE id = 'a'`).get() as {
      actor: string;
    };
    expect(row.actor).toBe("owner");
  });

  it("the ledger accepts the new owner source and owner_retired status (no CHECK constraint)", () => {
    const db = openTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
         first_seen_at, last_confirmed_at, valid_from, source, status)
       VALUES ('x', 'project.repo', 'v', 's', 'project', 0.9, ?, ?, ?, 'owner', 'owner_retired')`,
    ).run(now, now, now);
    const row = db.prepare(`SELECT source, status FROM canonical_facts WHERE id = 'x'`).get() as {
      source: string;
      status: string;
    };
    expect(row).toEqual({ source: "owner", status: "owner_retired" });
  });

  it("is idempotent on a database that already ran it", () => {
    const db = openTestDb();
    expect(() =>
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        ftsTable: "chunks_fts",
        ftsEnabled: false,
      }),
    ).not.toThrow();
  });
});
