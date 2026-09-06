/**
 * PLAN-45 Phase 1.1: tool-level execution rows get their run's grounded
 * outcome stamped from the journal; steering moves on the verdict, not on
 * the tool call.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { RUN_EVIDENCE_WHERE, SkillExecutionTracker } from "../skill-execution-tracker.js";
import { appendFixtureRun, makeFixtureJournal } from "./__fixtures__/journal-fixture.js";
import { backfillExecutionOutcomes } from "./execution-outcomes.js";

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       updated_at, created_at, semantic_type, skill_category)
     VALUES ('sk', 'skills/x', 'skills', 0, 0, 'body', 'h', 'test', '[]', 1, 1, 'skill', 'exec')`,
  ).run();
  return db;
}

function record(db: DatabaseSync, runId: string | undefined, success = true): string {
  const tracker = new SkillExecutionTracker(db);
  const id = tracker.startExecution("sk", "agent:main:main", {
    toolName: "exec",
    recordedBy: "after_tool_call",
    ...(runId ? { runId } : {}),
    evidence: "tool",
  });
  tracker.completeExecution(id, { success, rewardScore: undefined, toolCallsCount: 1 });
  return id;
}

const row = (db: DatabaseSync, id: string) =>
  db
    .prepare(
      `SELECT evidence, run_outcome_label, run_outcome_level FROM skill_executions WHERE id = ?`,
    )
    .get(id) as {
    evidence: string;
    run_outcome_label: string | null;
    run_outcome_level: number | null;
  };

const steering = (db: DatabaseSync) =>
  (
    db.prepare(`SELECT COALESCE(steering_reward, 0) AS s FROM chunks WHERE id = 'sk'`).get() as {
      s: number;
    }
  ).s;

describe("backfillExecutionOutcomes", () => {
  it("stamps pass/fail from the journal, lifts evidence, moves steering once per run", async () => {
    const db = openDb();
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "run-pass",
      task: { text: "list files" },
      steps: [
        { kind: "tool", name: "exec", result: "a" },
        { kind: "tool", name: "exec", result: "b" },
      ],
      completedExplicitly: true,
    });
    appendFixtureRun(journal, {
      runId: "run-fail",
      task: { text: "read config" },
      steps: [{ kind: "tool", name: "read", isError: true, result: "ENOENT: missing" }],
    });
    const p1 = record(db, "run-pass");
    const p2 = record(db, "run-pass");
    const f1 = record(db, "run-fail", false);
    expect(steering(db)).toBe(0); // tool completion no longer moves steering
    expect(row(db, p1).evidence).toBe("tool");

    const r = await backfillExecutionOutcomes({ journal, db, now: 10_000 });
    expect(r).toMatchObject({ stamped: 3, runs: 2, pending: 0, unattributable: 0 });
    expect(r.byLabel).toEqual({ pass: 1, fail: 1 });
    expect(row(db, p1)).toMatchObject({ evidence: "run", run_outcome_label: "pass" });
    expect(row(db, p2)).toMatchObject({ evidence: "run", run_outcome_label: "pass" });
    expect(row(db, f1)).toMatchObject({ evidence: "run", run_outcome_label: "fail" });
    // +0.1 once for the passing run, -0.05 once for the failing run.
    expect(steering(db)).toBeCloseTo(0.05);
    // Competence consumers now see 2 passes + 1 fail from these rows.
    const n = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM skill_executions WHERE ${RUN_EVIDENCE_WHERE}`)
        .get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(3);
    // Idempotent.
    const again = await backfillExecutionOutcomes({ journal, db, now: 10_000 });
    expect(again.stamped).toBe(0);
  });

  it("leaves in-flight runs pending, expires them after the TTL, stamps env-fail as tool evidence", async () => {
    const db = openDb();
    const journal = makeFixtureJournal();
    appendFixtureRun(journal, {
      runId: "inflight",
      task: { text: "x" },
      steps: [{ kind: "tool", name: "exec" }],
      terminal: "none",
    });
    appendFixtureRun(journal, {
      runId: "env",
      task: { text: "fetch" },
      steps: [
        { kind: "tool", name: "web_fetch", isError: true, result: "getaddrinfo ENOTFOUND host" },
      ],
    });
    const a = record(db, "inflight");
    const e = record(db, "env", false);
    const startedAt = (
      db.prepare(`SELECT started_at AS s FROM skill_executions WHERE id = ?`).get(a) as {
        s: number;
      }
    ).s;

    const r1 = await backfillExecutionOutcomes({ journal, db, now: startedAt + 1000 });
    expect(r1.pending).toBe(1);
    expect(row(db, a).run_outcome_label).toBeNull();
    expect(row(db, e)).toMatchObject({ evidence: "tool", run_outcome_label: "env-fail" });
    expect(steering(db)).toBe(0);

    const r2 = await backfillExecutionOutcomes({
      journal,
      db,
      now: startedAt + 10_000,
      pendingTtlMs: 5_000,
    });
    expect(r2.byLabel).toEqual({ unknown: 1 });
    expect(row(db, a)).toMatchObject({ evidence: "tool", run_outcome_label: "unknown" });
  });

  it("stamps pre-v64 rows without a run id as unattributable, and no-ops without a journal", async () => {
    const db = openDb();
    const legacy = record(db, undefined);
    const withRun = record(db, "r1");
    const r = await backfillExecutionOutcomes({ journal: null, db, now: 1 });
    expect(r.unattributable).toBe(1);
    expect(r.pending).toBe(1);
    expect(row(db, legacy)).toMatchObject({
      evidence: "tool",
      run_outcome_label: "unattributable",
    });
    expect(row(db, withRun).run_outcome_label).toBeNull();
  });
});
