/**
 * Execution-tracking hook: the F5 maturity re-publish trigger. Publish fires
 * at crystallization (0 executions, always fails the ≥3 gate); the hook is
 * the only place a skill can CROSS the gate, so it must call back exactly
 * then — and never for published crystals, failed executions, or unmatched
 * tools.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createExecutionTrackingHook } from "./execution-tracking-hook.js";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";
import { SkillExecutionTracker, stampExecutionRunOutcome } from "./skill-execution-tracker.js";

const NOW = 1_750_000_000_000;

function setup(): {
  db: DatabaseSync;
  tracker: SkillExecutionTracker;
  published: string[];
  fire: (toolName: string, error?: string) => void;
} {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  // MemStore adds these publish columns at runtime; the hook treats their
  // absence as "publishing never initialized" and skips, so tests that
  // exercise the callback need the real production shape.
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  db.prepare(
    `INSERT INTO chunks (
      id, path, source, start_line, end_line, text, hash, model, embedding,
      updated_at, created_at, lifecycle, semantic_type, skill_category
    ) VALUES ('sk1', 'peer/web-search', 'skills', 0, 0, 'skill body', 'h1', 'peer', '[]',
      ?, ?, 'frozen', 'skill', 'web-search')`,
  ).run(NOW, NOW);
  const tracker = new SkillExecutionTracker(db);
  const published: string[] = [];
  const hook = createExecutionTrackingHook(tracker, db, null, (id) => published.push(id));
  // PLAN-45 Phase 1.1: each fire is its own journal run, and the maturity
  // gate counts only rows whose run outcome has been stamped (the back-fill
  // does this in production; here the test stamps the PREVIOUS run before
  // the next call, the way a later pass would).
  let runNo = 0;
  const fire = (toolName: string, error?: string) => {
    if (runNo > 0) {
      stampExecutionRunOutcome(db, `run-${runNo}`, { label: error ? "fail" : "pass", level: 1 });
    }
    runNo += 1;
    hook(
      { toolName, params: {}, result: "ok", error, durationMs: 5 },
      { toolName, sessionKey: "s1", runId: `run-${runNo}`, toolCallId: `tc-${runNo}` },
    );
  };
  return { db, tracker, published, fire };
}

describe("createExecutionTrackingHook maturity re-publish (audit F5)", () => {
  it("fires the callback once the skill crosses the 3-execution gate and stays unpublished", () => {
    const { db, published, fire } = setup();
    fire("web_search");
    fire("web_search");
    fire("web_search");
    expect(published).toEqual([]); // 2 stamped runs + 1 fresh tool row: below the gate
    fire("web_search");
    expect(published).toEqual(["sk1"]); // 3 stamped runs: crossed
    fire("web_search");
    expect(published).toEqual(["sk1", "sk1"]); // keeps retrying while unpublished (gates decide)
    const rows = db
      .prepare(`SELECT run_id, tool_call_id, evidence FROM skill_executions ORDER BY started_at`)
      .all() as Array<{ run_id: string; tool_call_id: string; evidence: string }>;
    expect(rows[0]).toMatchObject({ run_id: "run-1", tool_call_id: "tc-1", evidence: "run" });
    expect(rows[4]).toMatchObject({ run_id: "run-5", evidence: "tool" }); // newest: not stamped yet
    db.close();
  });

  it("does not fire for an already-published crystal", () => {
    const { db, published, fire } = setup();
    db.prepare(`UPDATE chunks SET published_at = ? WHERE id = 'sk1'`).run(NOW);
    fire("web_search");
    fire("web_search");
    fire("web_search");
    expect(published).toEqual([]);
    db.close();
  });

  it("does not fire on a failed execution", () => {
    const { db, published, fire } = setup();
    fire("web_search");
    fire("web_search");
    fire("web_search");
    fire("web_search", "boom");
    expect(published).toEqual([]);
    db.close();
  });

  it("does nothing for tools with no matching skill crystal", () => {
    const { db, published, fire } = setup();
    fire("totally_unknown_tool_xyz");
    const execs = db.prepare(`SELECT COUNT(*) AS c FROM skill_executions`).get() as { c: number };
    expect(execs.c).toBe(0);
    expect(published).toEqual([]);
    db.close();
  });

  it("still records executions when no callback is provided", () => {
    const { db } = setup();
    const tracker = new SkillExecutionTracker(db);
    const hook = createExecutionTrackingHook(tracker, db, null);
    hook(
      { toolName: "web_search", params: {}, result: "ok", durationMs: 5 },
      { toolName: "web_search", sessionKey: "s1" },
    );
    const execs = db.prepare(`SELECT COUNT(*) AS c FROM skill_executions`).get() as { c: number };
    expect(execs.c).toBe(1);
    db.close();
  });
});

// PLAN-43 Phase 1 (R2): a remote A2A caller's turn must not move node
// state — no execution records, no steering, no publish re-attempts.
describe("createExecutionTrackingHook remote-task exclusion", () => {
  it("records nothing for a2a-task sessions", () => {
    const { db, published } = setup();
    const hook = createExecutionTrackingHook(new SkillExecutionTracker(db), db, null, (id) =>
      published.push(id),
    );
    hook(
      { toolName: "web_search", params: {}, result: "ok", durationMs: 5 },
      { toolName: "web_search", sessionKey: "agent:main:a2a-task:beef" },
    );
    const rows = db.prepare("SELECT COUNT(*) c FROM skill_executions").get() as { c: number };
    expect(rows.c).toBe(0);
    expect(published).toEqual([]);
  });
});

describe("createExecutionTrackingHook evidence semantics (PLAN-45 Phase 0)", () => {
  it("records reward_score NULL and never stimulates reward on a non-error call", () => {
    const { db } = setup();
    const stimulated: string[] = [];
    const hormonal = {
      stimulate: (kind: string) => stimulated.push(kind),
    } as unknown as Parameters<typeof createExecutionTrackingHook>[2];
    const tracker = new SkillExecutionTracker(db);
    const hook = createExecutionTrackingHook(tracker, db, hormonal);
    hook(
      {
        toolName: "web_search",
        params: {},
        result: "x".repeat(5000),
        error: undefined,
        durationMs: 5,
      },
      { toolName: "web_search", sessionKey: "s1" },
    );
    hook(
      { toolName: "web_search", params: {}, result: null, error: "boom", durationMs: 5 },
      { toolName: "web_search", sessionKey: "s1" },
    );
    expect(stimulated).toEqual(["error"]);
    const rows = db
      .prepare(
        `SELECT success, reward_score, recorded_by FROM skill_executions ORDER BY started_at`,
      )
      .all() as Array<{ success: number; reward_score: number | null; recorded_by: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reward_score === null)).toBe(true);
    expect(rows.every((r) => r.recorded_by === "after_tool_call")).toBe(true);
    expect(rows.map((r) => r.success)).toEqual([1, 0]);
  });
});
