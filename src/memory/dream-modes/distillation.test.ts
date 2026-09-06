/**
 * PLAN-40 Lane 1: verified-success distillation. Covers the success gate
 * (attribution required, success-rate floor, negative-feedback veto,
 * dream-origin exclusion), the one-note-per-skill guard, the started_at
 * cursor, and funnel production rows.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, beforeEach } from "vitest";
import { ensureMemoryIndexSchema } from "../memory-schema.js";
import { runMigrations } from "../migrations.js";
import { runDistillation, type DistillationOps } from "./distillation.js";

const NOW = 1_750_000_000_000;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  runMigrations(db);
});

function insertSkill(id: string, origin?: string): void {
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding,
       semantic_type, memory_type, skill_category, origin, created_at, updated_at)
     VALUES (?, 'skills/x', 'skills', 0, 0, 'A proven skill for web querying', ?, 'm', '[]',
       'skill', 'skill', 'web-search', ?, ?, ?)`,
  ).run(id, `h-${id}`, origin ?? null, NOW, NOW);
}

function insertExecution(
  skillId: string,
  i: number,
  opts: { success?: number; recordedBy?: string | null; feedback?: number | null } = {},
): void {
  // PLAN-45 Phase 1.1: distillation reads run-level evidence; a row's
  // `success` flag is the tool-level bit and no longer counts by itself.
  const success = opts.success ?? 1;
  db.prepare(
    `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success,
       user_feedback, recorded_by, evidence, run_outcome_label, run_outcome_level, run_outcome_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'run', ?, 1, ?)`,
  ).run(
    `e-${skillId}-${i}`,
    skillId,
    NOW + i * 1000,
    NOW + i * 1000 + 100,
    success,
    opts.feedback ?? null,
    opts.recordedBy === undefined ? "after_tool_call" : opts.recordedBy,
    success === 1 ? "pass" : "fail",
    NOW + i * 1000 + 200,
  );
}

const ops = (writes: string[]): DistillationOps => ({
  writeWorkflowNote: async (p) => {
    writes.push(p.skillCrystalId);
    return `note_${writes.length}`;
  },
});

const llm = async () =>
  "- Use the resilient query pattern\n- Back off with jitter\n- Log failures with context";

describe("runDistillation success gate", () => {
  it("distills a skill with >=3 attributed successes and records a funnel row", async () => {
    insertSkill("sk1");
    for (let i = 0; i < 3; i++) insertExecution("sk1", i);
    const writes: string[] = [];
    const r = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r.notes).toBe(1);
    expect(writes).toEqual(["sk1"]);
    const funnel = db
      .prepare(`SELECT lane FROM dream_utility WHERE artifact_id = 'note_1'`)
      .get() as { lane: string };
    expect(funnel.lane).toBe("distillation");
  });

  it("refuses unattributed executions (pre-v58 rows can never qualify)", async () => {
    insertSkill("sk1");
    for (let i = 0; i < 5; i++) insertExecution("sk1", i, { recordedBy: null });
    const writes: string[] = [];
    const r = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r.notes).toBe(0);
  });

  it("refuses below the success-rate floor and on any negative feedback", async () => {
    insertSkill("sk1");
    insertExecution("sk1", 0, { success: 1 });
    insertExecution("sk1", 1, { success: 0 });
    insertExecution("sk1", 2, { success: 0 });
    insertSkill("sk2");
    for (let i = 0; i < 3; i++) insertExecution("sk2", i, { feedback: i === 1 ? -1 : null });
    const writes: string[] = [];
    const r = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r.notes).toBe(0);
  });

  it("refuses dream-origin crystals (no paraphrase self-distillation)", async () => {
    insertSkill("sk1", "dream");
    for (let i = 0; i < 3; i++) insertExecution("sk1", i);
    const writes: string[] = [];
    const r = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r.notes).toBe(0);
  });

  it("one note per skill ever, and the cursor stops re-consideration", async () => {
    insertSkill("sk1");
    for (let i = 0; i < 3; i++) insertExecution("sk1", i);
    const writes: string[] = [];
    const r1 = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r1.notes).toBe(1);
    // Simulate the manager's deterministic-path write so the one-shot guard sees it.
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, text, hash, model, embedding, created_at, updated_at)
       VALUES ('note_row', 'distill/workflow/sk1', 'memory', 0, 0, 'note', 'h-n', 'm', '[]', ?, ?)`,
    ).run(NOW, NOW);
    // New executions arrive — cursor advanced, but even a fresh candidate hit
    // must be skipped by the existence guard.
    for (let i = 10; i < 13; i++) insertExecution("sk1", i);
    const r2 = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c2",
    });
    expect(r2.notes).toBe(0);
    expect(writes).toEqual(["sk1"]);
  });

  it("skips silently with no new fuel since the cursor", async () => {
    const writes: string[] = [];
    const r = await runDistillation({
      db,
      llmCall: llm,
      ops: ops(writes),
      llmBudget: 8,
      cycleId: "c1",
    });
    expect(r.notes + r.skillsConsidered).toBe(0);
  });
});
