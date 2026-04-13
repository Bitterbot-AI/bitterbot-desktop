/**
 * Tests for ExperimentSandbox: A/B mutation evaluation.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { ExperimentSandbox } from "./experiment-sandbox.js";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });
  ensureColumn(db, "chunks", "publish_visibility", "TEXT");
  ensureColumn(db, "chunks", "published_at", "INTEGER");
  return db;
}

function insertSkillExecution(
  db: DatabaseSync,
  skillId: string,
  success: boolean,
  rewardScore = 0.5,
  errorType: string | null = null,
) {
  const id = `exec-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success, reward_score, error_type)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, skillId, Date.now() - 1000, Date.now(), success ? 1 : 0, rewardScore, errorType);
}

const GOOD_EVAL_RESPONSE = JSON.stringify({
  criteriaScores: { edgeCases: 0.8, clarity: 0.9, intentPreservation: 0.95, improvement: 0.85 },
  testScenarios: [
    { scenario: "basic case", originalScore: 0.6, mutatedScore: 0.85 },
    { scenario: "edge case", originalScore: 0.4, mutatedScore: 0.8 },
    { scenario: "stress test", originalScore: 0.5, mutatedScore: 0.75 },
  ],
  overallMutatedScore: 0.82,
  reasoning: "mutation handles edge cases significantly better",
});

const BAD_EVAL_RESPONSE = JSON.stringify({
  criteriaScores: { edgeCases: 0.3, clarity: 0.4, intentPreservation: 0.6, improvement: 0.2 },
  testScenarios: [
    { scenario: "basic case", originalScore: 0.7, mutatedScore: 0.5 },
    { scenario: "edge case", originalScore: 0.6, mutatedScore: 0.4 },
  ],
  overallMutatedScore: 0.35,
  reasoning: "mutation loses core functionality",
});

const SKILL = {
  id: "skill-001",
  text: "When user asks to format code, use prettier with default settings",
  skill_category: "code-formatting",
  importance_score: 0.7,
};

describe("ExperimentSandbox", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("evaluate", () => {
    it("accepts a clearly improved mutation", async () => {
      // Seed baseline: 60% success
      for (let i = 0; i < 10; i++) {
        insertSkillExecution(db, SKILL.id, i < 6, 0.5);
      }

      const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE);
      const verdict = await sandbox.evaluate(SKILL, "improved skill text");

      expect(verdict.accepted).toBe(true);
      expect(verdict.delta).toBeGreaterThan(0.05);
      expect(verdict.mutatedScore).toBeGreaterThan(verdict.originalScore);
      expect(verdict.testCasesRun).toBe(3);
      expect(verdict.confidence).toBeGreaterThan(0);
      expect(verdict.reason).toContain("improves");
    });

    it("rejects a mutation that degrades performance", async () => {
      for (let i = 0; i < 10; i++) {
        insertSkillExecution(db, SKILL.id, i < 7, 0.6);
      }

      const sandbox = new ExperimentSandbox(db, async () => BAD_EVAL_RESPONSE);
      const verdict = await sandbox.evaluate(SKILL, "worse skill text");

      expect(verdict.accepted).toBe(false);
      expect(verdict.delta).toBeLessThan(0);
      expect(verdict.testCasesRun).toBe(2);
    });

    it("returns all required MutationVerdict fields", async () => {
      insertSkillExecution(db, SKILL.id, true, 0.5);
      insertSkillExecution(db, SKILL.id, false, 0.3);

      const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE);
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      expect(typeof verdict.accepted).toBe("boolean");
      expect(typeof verdict.confidence).toBe("number");
      expect(typeof verdict.delta).toBe("number");
      expect(typeof verdict.testCasesRun).toBe("number");
      expect(typeof verdict.originalScore).toBe("number");
      expect(typeof verdict.mutatedScore).toBe("number");
      expect(typeof verdict.reason).toBe("string");
      expect(verdict.originalScore).toBeGreaterThanOrEqual(0);
      expect(verdict.originalScore).toBeLessThanOrEqual(1);
      expect(verdict.mutatedScore).toBeGreaterThanOrEqual(0);
      expect(verdict.mutatedScore).toBeLessThanOrEqual(1);
    });

    it("handles LLM returning garbage gracefully", async () => {
      insertSkillExecution(db, SKILL.id, true, 0.7);

      const sandbox = new ExperimentSandbox(db, async () => "not json at all");
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      expect(verdict.accepted).toBe(false);
      expect(verdict.testCasesRun).toBe(1);
      expect(verdict.reason).toContain("could not be parsed");
    });

    it("handles LLM throwing an error", async () => {
      const sandbox = new ExperimentSandbox(db, async () => {
        throw new Error("LLM timeout");
      });
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      expect(verdict.accepted).toBe(false);
      expect(verdict.testCasesRun).toBe(1);
      expect(verdict.reason).toContain("evaluation failed");
    });

    it("handles markdown-wrapped JSON response", async () => {
      insertSkillExecution(db, SKILL.id, true, 0.5);

      const wrappedResponse = "```json\n" + GOOD_EVAL_RESPONSE + "\n```";
      const sandbox = new ExperimentSandbox(db, async () => wrappedResponse);
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      expect(verdict.testCasesRun).toBe(3);
      expect(typeof verdict.delta).toBe("number");
    });

    it("uses default baseline when no executions exist", async () => {
      const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE);
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      // Default baseline is 0.5 success + 0.5 reward → originalScore = 0.5
      expect(verdict.originalScore).toBeCloseTo(0.5, 1);
    });

    it("clamps all scores to 0-1 range", async () => {
      insertSkillExecution(db, SKILL.id, true, 0.9);

      const extremeResponse = JSON.stringify({
        criteriaScores: { edgeCases: 5.0, clarity: -1.0 },
        testScenarios: [{ scenario: "test", originalScore: 2.0, mutatedScore: -0.5 }],
        overallMutatedScore: 1.5,
        reasoning: "extreme values",
      });

      const sandbox = new ExperimentSandbox(db, async () => extremeResponse);
      const verdict = await sandbox.evaluate(SKILL, "test mutation");

      expect(verdict.mutatedScore).toBeLessThanOrEqual(1);
      expect(verdict.mutatedScore).toBeGreaterThanOrEqual(0);
      expect(verdict.confidence).toBeLessThanOrEqual(1);
      expect(verdict.confidence).toBeGreaterThanOrEqual(0);
    });
  });
});
