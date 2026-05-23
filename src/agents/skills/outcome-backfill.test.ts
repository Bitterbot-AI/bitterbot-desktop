import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { backfillOutcomesFromUserMessage } from "./outcome-backfill.js";

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

function insertRecord(
  db: DatabaseSync,
  args: {
    id: string;
    ts: number;
    sessionKey: string;
    interventionType: string;
  },
): void {
  db.prepare(
    `INSERT INTO intervention_records (
       id, ts, session_key, skill, interceptor_id, channel, tool_name,
       intervention_type, action_original_json, intervention_json,
       state_summary_json, record_json
     ) VALUES (?, ?, ?, 'test', 'test:1', 'internal', 'send_message',
              ?, '{}', '{}', '{}', '{}')`,
  ).run(args.id, args.ts, args.sessionKey, args.interventionType);
}

describe("outcome-backfill", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openTestDb();
  });

  it("marks recent non-block records downstream-success on thanks-shaped reply", () => {
    insertRecord(db, {
      id: "r1",
      ts: Date.now() - 30_000,
      sessionKey: "s",
      interventionType: "modify",
    });
    backfillOutcomesFromUserMessage({ db, sessionKey: "s", userText: "perfect, thanks!" });
    const row = db.prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r1'`).get() as {
      outcome_tag: string;
    };
    expect(row.outcome_tag).toBe("downstream-success");
  });

  it("marks block records user-confirmed-block on cancel-shaped reply", () => {
    insertRecord(db, {
      id: "r2",
      ts: Date.now() - 30_000,
      sessionKey: "s",
      interventionType: "block",
    });
    backfillOutcomesFromUserMessage({ db, sessionKey: "s", userText: "cancel that" });
    const row = db.prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r2'`).get() as {
      outcome_tag: string;
    };
    expect(row.outcome_tag).toBe("user-confirmed-block");
  });

  it("marks block records user-overrode-block on confirm-shaped reply", () => {
    insertRecord(db, {
      id: "r3",
      ts: Date.now() - 30_000,
      sessionKey: "s",
      interventionType: "block",
    });
    backfillOutcomesFromUserMessage({ db, sessionKey: "s", userText: "yes do it anyway" });
    const row = db.prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r3'`).get() as {
      outcome_tag: string;
    };
    expect(row.outcome_tag).toBe("user-overrode-block");
  });

  it("ignores records outside the recency window", () => {
    insertRecord(db, {
      id: "r4",
      ts: Date.now() - 10 * 60_000,
      sessionKey: "s",
      interventionType: "modify",
    });
    backfillOutcomesFromUserMessage({ db, sessionKey: "s", userText: "thanks!" });
    const row = db.prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r4'`).get() as {
      outcome_tag: string | null;
    };
    expect(row.outcome_tag).toBeNull();
  });

  it("does not overwrite an already-set outcome", () => {
    insertRecord(db, {
      id: "r5",
      ts: Date.now() - 30_000,
      sessionKey: "s",
      interventionType: "modify",
    });
    db.prepare(
      `UPDATE intervention_records SET outcome_tag='downstream-failure' WHERE id='r5'`,
    ).run();
    backfillOutcomesFromUserMessage({ db, sessionKey: "s", userText: "thanks!" });
    const row = db.prepare(`SELECT outcome_tag FROM intervention_records WHERE id='r5'`).get() as {
      outcome_tag: string;
    };
    expect(row.outcome_tag).toBe("downstream-failure");
  });
});
