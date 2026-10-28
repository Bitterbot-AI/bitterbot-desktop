/**
 * v79 (PLAN-59 Phase 0): the evidence telemetry tables. DDL only, idempotent,
 * starts empty, and rolls back cleanly like every other migration.
 */

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

const tables = (db: DatabaseSync): string[] =>
  (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);

const indexes = (db: DatabaseSync, table: string): string[] =>
  (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`)
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

describe("migration v79 (PLAN-59 Phase 0 evidence tables)", () => {
  it("is the latest migration and creates the four tables with their indexes", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(79);
    expect(MIGRATIONS.some((m) => m.version === 79)).toBe(true);
    const db = openTestDb();
    const t = tables(db);
    for (const name of ["retrieval_hits", "surfacing_events", "decision_traces", "evidence_meta"]) {
      expect(t).toContain(name);
    }
    expect(columns(db, "retrieval_hits")).toEqual([
      "id",
      "query_id",
      "query_digest",
      "session_digest",
      "caller",
      "query_len",
      "chunk_id",
      "rank",
      "fused_score",
      "channel_ranks_json",
      "injected",
      "cited",
      "embedding_model",
      "scoring_version",
      "created_at",
    ]);
    expect(columns(db, "surfacing_events")).toEqual([
      "id",
      "event_id",
      "kind",
      "ref_id",
      "arm",
      "opportunity_id",
      "session_digest",
      "stage",
      "outcome",
      "label_provenance",
      "cost_usd",
      "created_at",
      "outcome_at",
    ]);
    expect(columns(db, "decision_traces")).toEqual([
      "id",
      "kind",
      "legacy_json",
      "proposed_json",
      "diverged",
      "scoring_version",
      "created_at",
    ]);
    expect(indexes(db, "retrieval_hits")).toEqual(
      expect.arrayContaining([
        "idx_retrieval_hits_created",
        "idx_retrieval_hits_chunk",
        "idx_retrieval_hits_query",
      ]),
    );
    expect(indexes(db, "surfacing_events")).toEqual(
      expect.arrayContaining(["idx_surfacing_events_created", "idx_surfacing_events_ref"]),
    );
    expect(indexes(db, "decision_traces")).toContain("idx_decision_traces_created");
  });

  it("starts empty apart from the schema note and has no digest key until a writer needs one", () => {
    const db = openTestDb();
    for (const name of ["retrieval_hits", "surfacing_events", "decision_traces"]) {
      expect((db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c).toBe(0);
    }
    const meta = db.prepare(`SELECT key FROM evidence_meta ORDER BY key`).all() as Array<{
      key: string;
    }>;
    expect(meta.map((r) => r.key)).toEqual(["schema_note"]);
  });

  it("re-running from v78 is idempotent and keeps rows", () => {
    const db = openTestDb();
    db.prepare(
      `INSERT INTO surfacing_events (event_id, kind, stage, created_at) VALUES ('e', 'k', 'delivered', 1)`,
    ).run();
    db.prepare(`UPDATE meta SET value = '78' WHERE key = 'schema_version'`).run();
    const res = runMigrations(db);
    expect(res.from).toBe(78);
    expect(res.to).toBe(LATEST_SCHEMA_VERSION);
    expect(
      (db.prepare(`SELECT COUNT(*) AS c FROM surfacing_events`).get() as { c: number }).c,
    ).toBe(1);
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS c FROM evidence_meta WHERE key = 'schema_note'`).get() as {
          c: number;
        }
      ).c,
    ).toBe(1);
  });

  it("enforces the event_id uniqueness the writer's INSERT OR IGNORE relies on", () => {
    const db = openTestDb();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO surfacing_events (event_id, kind, stage, created_at) VALUES ('dup', 'k', 'delivered', 1)`,
    );
    expect(Number(ins.run().changes)).toBe(1);
    expect(Number(ins.run().changes)).toBe(0);
  });
});
