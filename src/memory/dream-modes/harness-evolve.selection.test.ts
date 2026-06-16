import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isHeldOut } from "../skill-execution-selection.js";
import { listGlobalHeldOutExecutions } from "./harness-evolve.selection.js";

function makeDb(n: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE skill_executions (
    id TEXT PRIMARY KEY, skill_crystal_id TEXT, session_id TEXT,
    started_at INTEGER, completed_at INTEGER, success INTEGER,
    reward_score REAL, error_type TEXT)`);
  const stmt = db.prepare(
    `INSERT INTO skill_executions
     (id, skill_crystal_id, session_id, started_at, completed_at, success, reward_score, error_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(
      `exec-${i}`,
      `skill-${i % 4}`,
      "s1",
      1000 + i,
      2000 + i,
      i % 3 === 0 ? 0 : 1,
      0.5,
      null,
    );
  }
  return db;
}

describe("listGlobalHeldOutExecutions (PLAN-25)", () => {
  it("returns only held-out ids, deterministically", () => {
    const db = makeDb(80);
    const a = listGlobalHeldOutExecutions(db, { limit: 50 });
    const b = listGlobalHeldOutExecutions(db, { limit: 50 });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a.length).toBeGreaterThan(0);
    for (const e of a) expect(isHeldOut(e.id)).toBe(true);
  });

  it("respects the limit and maps fields", () => {
    const db = makeDb(200);
    const out = listGlobalHeldOutExecutions(db, { limit: 5 });
    expect(out.length).toBe(5);
    expect(typeof out[0].success).toBe("boolean");
    expect(out[0].skillId).toMatch(/^skill-/);
  });

  it("returns [] when the table is absent", () => {
    expect(listGlobalHeldOutExecutions(new DatabaseSync(":memory:"))).toEqual([]);
  });
});
