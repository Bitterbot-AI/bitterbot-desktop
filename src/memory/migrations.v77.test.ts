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

describe("migration v77 — canonical_facts.scope and evidence_ref (PLAN-55 Phase 1)", () => {
  it("is the latest schema version", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(77);
  });

  it("adds scope (NOT NULL, default 'global'), evidence_ref (nullable) and the scope index", () => {
    const db = openTestDb();
    const cols = db.prepare(`PRAGMA table_info(canonical_facts)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scope = cols.find((c) => c.name === "scope");
    const evidence = cols.find((c) => c.name === "evidence_ref");
    expect(scope).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'global'" });
    expect(evidence).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    const indexes = (
      db.prepare(`PRAGMA index_list(canonical_facts)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(indexes).toContain("idx_canonical_facts_scope");
  });

  it("existing rows read as global with no evidence; new rows may set both", () => {
    const db = openTestDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
         first_seen_at, last_confirmed_at, valid_from, source)
       VALUES ('old', 'project.repo', 'v', 's', 'project', 0.9, ?, ?, ?, 'seed')`,
    ).run(now, now, now);
    db.prepare(
      `INSERT INTO canonical_facts (id, key, value, statement, category, confidence,
         first_seen_at, last_confirmed_at, valid_from, source, scope, evidence_ref)
       VALUES ('new', 'infra.x', 'v', 's', 'infra', 0.9, ?, ?, ?, 'owner', 'project:acme', 'session:/s#L2')`,
    ).run(now, now, now);
    const rows = db
      .prepare(`SELECT id, scope, evidence_ref FROM canonical_facts ORDER BY id`)
      .all() as Array<{ id: string; scope: string; evidence_ref: string | null }>;
    expect(rows).toEqual([
      { id: "new", scope: "project:acme", evidence_ref: "session:/s#L2" },
      { id: "old", scope: "global", evidence_ref: null },
    ]);
  });

  it("is idempotent, and a no-op on a database without the ledger table", () => {
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
    const v77 = MIGRATIONS.find((m) => m.version === 77)!;
    expect(() => runMigrations(bare, [v77])).not.toThrow();
  });
});
