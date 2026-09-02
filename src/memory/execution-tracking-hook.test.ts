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
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

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
  const fire = (toolName: string, error?: string) =>
    hook(
      { toolName, params: {}, result: "ok", error, durationMs: 5 },
      { toolName, sessionKey: "s1" },
    );
  return { db, tracker, published, fire };
}

describe("createExecutionTrackingHook maturity re-publish (audit F5)", () => {
  it("fires the callback once the skill crosses the 3-execution gate and stays unpublished", () => {
    const { db, published, fire } = setup();
    fire("web_search");
    fire("web_search");
    expect(published).toEqual([]); // below the gate
    fire("web_search");
    expect(published).toEqual(["sk1"]); // crossed at 3
    fire("web_search");
    expect(published).toEqual(["sk1", "sk1"]); // keeps retrying while unpublished (gates decide)
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
