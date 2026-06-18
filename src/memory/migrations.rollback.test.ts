/**
 * Migrations run atomically: each migration + its schema-version bump commit
 * together, and any failure rolls the whole migration back rather than leaving
 * a half-applied schema that a later run would silently skip.
 */
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "./migrations.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  return db;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function version(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

describe("runMigrations transactional safety", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it("commits a successful migration and bumps the version", () => {
    const migs: Migration[] = [
      { version: 1, description: "ok", up: (d) => d.exec("CREATE TABLE ok (id TEXT)") },
    ];
    const res = runMigrations(db, migs);
    expect(res).toEqual({ from: 0, to: 1, ran: 1 });
    expect(tableExists(db, "ok")).toBe(true);
    expect(version(db)).toBe(1);
  });

  it("rolls back a migration that fails partway — no partial schema, version unchanged", () => {
    const migs: Migration[] = [
      {
        version: 1,
        description: "partial then throw",
        up: (d) => {
          d.exec("CREATE TABLE half_applied (id TEXT)");
          throw new Error("boom");
        },
      },
    ];
    const res = runMigrations(db, migs);
    expect(res.to).toBe(0); // nothing applied
    expect(tableExists(db, "half_applied")).toBe(false); // rolled back
    expect(version(db)).toBe(0); // version not bumped
  });

  it("stops at the first failure but keeps earlier committed migrations", () => {
    const migs: Migration[] = [
      { version: 1, description: "good", up: (d) => d.exec("CREATE TABLE good (id TEXT)") },
      {
        version: 2,
        description: "bad",
        up: (d) => {
          d.exec("CREATE TABLE never (id TEXT)");
          throw new Error("boom");
        },
      },
      { version: 3, description: "skipped", up: (d) => d.exec("CREATE TABLE skipped (id TEXT)") },
    ];
    const res = runMigrations(db, migs);
    expect(res.to).toBe(1);
    expect(tableExists(db, "good")).toBe(true); // v1 committed
    expect(tableExists(db, "never")).toBe(false); // v2 rolled back
    expect(tableExists(db, "skipped")).toBe(false); // v3 never ran
    expect(version(db)).toBe(1);
  });
});
