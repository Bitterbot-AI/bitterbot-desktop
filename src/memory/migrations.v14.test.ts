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

describe("migration v14 — intervention_records", () => {
  it("creates the intervention_records table with the right columns", () => {
    const db = openTestDb();
    const cols = db.prepare(`PRAGMA table_info(intervention_records)`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id",
        "ts",
        "session_key",
        "skill",
        "interceptor_id",
        "channel",
        "tool_name",
        "intervention_type",
        "action_original_json",
        "action_final_json",
        "intervention_json",
        "state_summary_json",
        "activation_latency_ms",
        "intervention_latency_ms",
        "outcome_tag",
        "outcome_evidence",
        "ed25519_sig",
        "pubkey_id",
        "record_json",
      ]),
    );
  });

  it("creates the skill_interceptor_stats aggregation view", () => {
    const db = openTestDb();
    const row = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='view' AND name='skill_interceptor_stats'`,
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("skill_interceptor_stats");
  });

  it("creates the expected indexes", () => {
    const db = openTestDb();
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='intervention_records'`,
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_intervention_records_skill_ts",
        "idx_intervention_records_interceptor_ts",
        "idx_intervention_records_session_ts",
        "idx_intervention_records_outcome",
      ]),
    );
  });

  it("is idempotent — running migrations twice does not throw", () => {
    const db = openTestDb();
    expect(() => runMigrations(db)).not.toThrow();
  });
});
