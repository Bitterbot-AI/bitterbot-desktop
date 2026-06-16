import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { mineFailureClusters } from "./harness-evolve.weakness.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE intervention_records (
    id TEXT PRIMARY KEY, ts INTEGER, session_key TEXT, skill TEXT, interceptor_id TEXT,
    channel TEXT, tool_name TEXT, intervention_type TEXT, outcome_tag TEXT)`);
  db.exec(`CREATE TABLE skill_executions (
    id TEXT PRIMARY KEY, skill_crystal_id TEXT, started_at INTEGER, completed_at INTEGER,
    success INTEGER, error_type TEXT)`);
  return db;
}

const NOW = 1_000_000_000_000;

describe("mineFailureClusters (PLAN-25)", () => {
  it("clusters intervention failures by exact signature and ranks by frequency", () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO intervention_records
       (id, ts, session_key, skill, interceptor_id, channel, tool_name, intervention_type, outcome_tag)
       VALUES (?, ?, 's', 'sk', 'ic', 'internal', ?, ?, ?)`,
    );
    // 3 identical routing failures + 1 different override → two clusters.
    for (let i = 0; i < 3; i++)
      ins.run(`i${i}`, NOW - i * 1000, "memory_search", "modify", "downstream-failure");
    ins.run("i9", NOW, "bash", "block", "user-overrode-block");

    const clusters = mineFailureClusters(db, { nowMs: NOW });
    expect(clusters.length).toBe(2);
    expect(clusters[0].count).toBe(3); // most frequent first
    expect(clusters[0].signature.surface).toBe("tools");
    expect(clusters[0].signature.mechanism).toBe("modify:memory_search");
    const override = clusters.find((c) => c.signature.terminalCause === "user-overrode-block");
    expect(override?.signature.surface).toBe("prompt");
  });

  it("classifies skill_execution errors to a surface", () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success, error_type)
       VALUES (?, ?, ?, ?, 0, ?)`,
    );
    ins.run("e1", "sk-a", NOW, NOW, "context_window_overflow");
    ins.run("e2", "sk-b", NOW, NOW, "tool_not_found");
    const clusters = mineFailureClusters(db, { nowMs: NOW });
    const surfaces = clusters.map((c) => c.signature.surface).toSorted();
    expect(surfaces).toEqual(["compaction", "tools"]);
  });

  it("ignores records older than the window and returns [] with no tables", () => {
    expect(mineFailureClusters(new DatabaseSync(":memory:"), { nowMs: NOW })).toEqual([]);
    const db = makeDb();
    db.prepare(
      `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success, error_type)
       VALUES ('old', 'sk', ?, ?, 0, 'x')`,
    ).run(NOW - 90 * 24 * 3600 * 1000, NOW);
    expect(mineFailureClusters(db, { nowMs: NOW, maxAgeMs: 30 * 24 * 3600 * 1000 })).toEqual([]);
  });
});
