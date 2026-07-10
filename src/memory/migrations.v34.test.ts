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
 * Roll schema_version back to 33 so runMigrations re-applies v34. All v34
 * DDL is idempotent (CREATE IF NOT EXISTS / addColumnIfMissing), so the
 * only observable effect of a re-run is the containment sweep — exactly
 * what these tests need to exercise against hand-seeded pre-sweep rows.
 */
function rewindToV33(db: DatabaseSync): void {
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

describe("migration v34 — PLAN-34 Phase 0 schema slots + containment sweeps", () => {
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

  it("adds epistemic_directives.status defaulting to 'open'", () => {
    const db = openTestDb();
    expect(columns(db, "epistemic_directives")).toContain("status");
    insertDirective(db, "d-status", 0, null);
    const row = db
      .prepare(`SELECT status FROM epistemic_directives WHERE id = 'd-status'`)
      .get() as { status: string };
    expect(row.status).toBe("open");
  });

  it("resets attempts to 0 on unresolved directives only (the attempts=491 artifact)", () => {
    const db = openTestDb();
    insertDirective(db, "d-unresolved", 491, null);
    insertDirective(db, "d-resolved", 5, Date.now());
    rewindToV33(db);
    runMigrations(db);
    const get = (id: string) =>
      (
        db.prepare(`SELECT attempts FROM epistemic_directives WHERE id = ?`).get(id) as {
          attempts: number;
        }
      ).attempts;
    expect(get("d-unresolved")).toBe(0);
    expect(get("d-resolved")).toBe(5);
  });

  it("re-runs idempotently against the 2026-07-10 manual-sweep state", () => {
    const db = openTestDb();
    insertDirective(db, "d1", 12, null);
    rewindToV33(db);
    runMigrations(db);
    rewindToV33(db);
    // Second re-run: no throw, no drift.
    runMigrations(db);
    const row = db.prepare(`SELECT attempts FROM epistemic_directives WHERE id = 'd1'`).get() as {
      attempts: number;
    };
    expect(row.attempts).toBe(0);
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
