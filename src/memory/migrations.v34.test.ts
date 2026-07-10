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

function tables(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

/**
 * Rebuild a genuine pre-v34 schema: drop the v34 columns and table, then
 * roll schema_version back to 33. Rows inserted after this run against the
 * real v33 shape, so a subsequent runMigrations exercises the actual
 * ALTER-time upgrade path (column backfill on populated tables), not just
 * INSERT-time defaults — the Phase 0 adversarial pass caught that a
 * version-rewind alone only re-runs idempotent no-op DDL.
 */
function downgradeToV33(db: DatabaseSync): void {
  db.exec(`ALTER TABLE chunks DROP COLUMN session_trust`);
  db.exec(`ALTER TABLE epistemic_directives DROP COLUMN status`);
  db.exec(`DROP TABLE canonical_conflicts`);
  db.prepare(`UPDATE meta SET value = '33' WHERE key = 'schema_version'`).run();
}

function insertDirective(
  db: DatabaseSync,
  id: string,
  attempts: number,
  resolvedAt: number | null,
): void {
  db.prepare(
    `INSERT INTO epistemic_directives
       (id, directive_type, question, created_at, resolved_at, attempts)
     VALUES (?, 'graph_bridge', 'q?', ?, ?, ?)`,
  ).run(id, Date.now(), resolvedAt, attempts);
}

describe("migration v34 — PLAN-34 Phase 0 schema slots", () => {
  it("adds chunks.session_trust", () => {
    expect(columns(openTestDb(), "chunks")).toContain("session_trust");
  });

  it("creates canonical_conflicts with the Phase 1 sweep columns", () => {
    const db = openTestDb();
    expect(tables(db).has("canonical_conflicts")).toBe(true);
    const cols = columns(db, "canonical_conflicts");
    for (const c of [
      "key",
      "kind",
      "current_value",
      "proposed_value",
      "current_source",
      "proposed_source",
      "created_at",
      "consumed_at",
      "directive_id",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("upgrades a populated v33 DB: existing directive rows are backfilled to status='open'", () => {
    const db = openTestDb();
    downgradeToV33(db);
    // Rows inserted against the REAL v33 shape (no status column).
    insertDirective(db, "d-pre-upgrade", 491, null);
    insertDirective(db, "d-pre-resolved", 5, Date.now());

    runMigrations(db);

    const rows = db
      .prepare(`SELECT id, status, attempts FROM epistemic_directives ORDER BY id`)
      .all() as Array<{ id: string; status: string; attempts: number }>;
    expect(rows.map((r) => r.status)).toEqual(["open", "open"]);
    // v34 deliberately does NOT reset attempts: the reset ships with the
    // Phase 1 read-side fix so it cannot be consumed by the old per-read
    // incrementer before the new semantics exist.
    expect(rows.find((r) => r.id === "d-pre-upgrade")?.attempts).toBe(491);
    expect(columns(db, "chunks")).toContain("session_trust");
    expect(tables(db).has("canonical_conflicts")).toBe(true);
  });

  it("re-runs without throwing and preserves directive data", () => {
    const db = openTestDb();
    insertDirective(db, "d1", 7, null);
    // Version-only rewind: v34's DDL re-runs against an already-upgraded
    // schema and must be a data-preserving no-op.
    db.prepare(`UPDATE meta SET value = '33' WHERE key = 'schema_version'`).run();
    runMigrations(db);
    const row = db
      .prepare(`SELECT attempts, status FROM epistemic_directives WHERE id = 'd1'`)
      .get() as { attempts: number; status: string };
    expect(row.attempts).toBe(7);
    expect(row.status).toBe("open");
  });

  it("is idempotent and lands schema version >= 34", () => {
    const db = openTestDb();
    const second = runMigrations(db);
    expect(second.ran).toBe(0);
    const row = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {
      value: string;
    };
    expect(Number(row.value)).toBeGreaterThanOrEqual(34);
  });
});
