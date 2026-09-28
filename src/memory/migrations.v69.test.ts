/**
 * Migration v69: repair per-copy rejection inflation from re-broadcast legacy
 * crystals, and clear stale anomaly flags (2026-09-28 skills-received audit).
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

function rewindTo(db: DatabaseSync, version: number): void {
  db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(version));
}

describe("migration v69: skill-receive accounting repair", () => {
  it("caps rejections at receipts and clears anomaly flags, leaving sane rows alone", () => {
    const db = openMigratedDb();
    const insert = db.prepare(
      `INSERT INTO peer_reputation
         (peer_pubkey, peer_id, skills_received, skills_accepted, skills_rejected,
          anomaly_flag, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
    );
    insert.run("inflated", "12D3KooWInflated", 154, 0, 965, 1);
    insert.run("sane", "12D3KooWSane", 10, 4, 6, 0);
    rewindTo(db, 68);
    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT peer_pubkey, skills_received, skills_accepted, skills_rejected, anomaly_flag
           FROM peer_reputation ORDER BY peer_pubkey`,
      )
      .all();
    expect(rows).toEqual([
      {
        peer_pubkey: "inflated",
        skills_received: 154,
        skills_accepted: 0,
        skills_rejected: 154,
        anomaly_flag: 0,
      },
      {
        peer_pubkey: "sane",
        skills_received: 10,
        skills_accepted: 4,
        skills_rejected: 6,
        anomaly_flag: 0,
      },
    ]);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(69);
    db.close();
  });

  it("is idempotent", () => {
    const db = openMigratedDb();
    rewindTo(db, 68);
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
