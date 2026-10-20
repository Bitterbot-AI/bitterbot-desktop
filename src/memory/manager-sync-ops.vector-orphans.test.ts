/**
 * PLAN-45 Phase 0: the one-time vector orphan sweep. Migration v63 deletes
 * chunks while sqlite-vec is not loaded, so the manager removes vector rows
 * with no chunk once the extension is ready, and stamps meta so it never
 * rescans on later boots.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { memoryManagerSyncOps } from "./manager-sync-ops.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE chunks (id TEXT PRIMARY KEY);
    CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB);
    INSERT INTO chunks VALUES ('live');
    INSERT INTO chunks_vec VALUES ('live', x'00'), ('orphan-1', x'00'), ('orphan-2', x'00');
  `);
  return db;
}

type SweepHost = { db: DatabaseSync; vectorOrphanSweepDone: boolean };
const sweep = (host: SweepHost): void =>
  (
    memoryManagerSyncOps as unknown as { sweepVectorOrphansOnce(this: SweepHost): void }
  ).sweepVectorOrphansOnce.call(host);

describe("sweepVectorOrphansOnce", () => {
  it("removes vector rows with no chunk, stamps meta, and never rescans", () => {
    const db = openDb();
    const host: SweepHost = { db, vectorOrphanSweepDone: false };
    sweep(host);
    const ids = (
      db.prepare(`SELECT id FROM chunks_vec ORDER BY id`).all() as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["live"]);
    expect(
      db.prepare(`SELECT value FROM meta WHERE key = 'vector_orphan_sweep_v63'`).get(),
    ).toEqual(expect.objectContaining({ value: "1" }));
    // A later orphan is not touched by the one-time sweep (stamped).
    db.exec(`INSERT INTO chunks_vec VALUES ('later-orphan', x'00')`);
    sweep({ db, vectorOrphanSweepDone: false });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chunks_vec`).get()).toEqual(
      expect.objectContaining({ n: 2 }),
    );
  });

  it("does not stamp meta when the delete fails, so the next boot retries", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE chunks (id TEXT)`);
    const host: SweepHost = { db, vectorOrphanSweepDone: false };
    expect(() => sweep(host)).not.toThrow();
    expect(host.vectorOrphanSweepDone).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM meta`).get()).toEqual(
      expect.objectContaining({ n: 0 }),
    );
  });
});
