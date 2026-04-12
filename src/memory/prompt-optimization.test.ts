import crypto from "node:crypto";
/**
 * Tests for PromptOptimizationExperiment: candidate finding and mutation generation.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";
import { PromptOptimizationExperiment } from "./prompt-optimization.js";
import { SkillExecutionTracker } from "./skill-execution-tracker.js";

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

function insertSkillChunk(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    text: string;
    skill_category: string | null;
    importance_score: number;
    memory_type: string;
    semantic_type: string;
    last_dreamed_at: number | null;
  }> = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const now = Date.now();
  const dummyEmbedding = JSON.stringify([0.1, 0.2, 0.3, 0.4]);
  db.prepare(
    `INSERT INTO chunks (id, path, source, text, hash, embedding, importance_score, memory_type, semantic_type,
       skill_category, last_dreamed_at, created_at, updated_at, start_line, end_line, model, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'test', 1)`,
  ).run(
    id,
    "/skills/test",
    "skill",
    overrides.text ?? "test skill text",
    crypto.randomUUID(),
    dummyEmbedding,
    overrides.importance_score ?? 0.5,
    overrides.memory_type ?? "skill",
    overrides.semantic_type ?? "skill",
    overrides.skill_category ?? null,
    overrides.last_dreamed_at ?? null,
    now,
    now,
  );
  return id;
}

function seedExecutions(
  db: DatabaseSync,
  skillId: string,
  successCount: number,
  failCount: number,
  rewardScore = 0.5,
) {
  const tracker = new SkillExecutionTracker(db);
  for (let i = 0; i < successCount; i++) {
    const execId = tracker.startExecution(skillId);
    tracker.completeExecution(execId, { success: true, rewardScore });
  }
  for (let i = 0; i < failCount; i++) {
    const execId = tracker.startExecution(skillId);
    tracker.completeExecution(execId, {
      success: false,
      rewardScore: 0,
      errorType: "test_error",
    });
  }
}

const MUTATION_LLM_RESPONSE = JSON.stringify([
  { content: "improved version 1", confidence: 0.8, keywords: ["better"] },
  { content: "improved version 2", confidence: 0.6, keywords: ["alternative"] },
  { content: "improved version 3", confidence: 0.7, keywords: ["robust"] },
]);

describe("PromptOptimizationExperiment", () => {
  let db: DatabaseSync;
  let tracker: SkillExecutionTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new SkillExecutionTracker(db);
  });

  describe("findCandidates", () => {
    it("returns empty when no skills exist", () => {
      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(10)).toEqual([]);
    });

    it("returns empty when skills have no executions", () => {
      insertSkillChunk(db, { text: "no executions skill" });
      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(10)).toEqual([]);
    });

    it("returns empty when skills have too few executions", () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 1, 1); // only 2 executions, need 3+
      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(10)).toEqual([]);
    });

    it("finds skills with moderate success rate (0.3-0.9)", () => {
      const id = insertSkillChunk(db, {
        text: "a skill that works sometimes",
        importance_score: 0.8,
      });
      seedExecutions(db, id, 4, 3); // ~57% success rate

      const exp = new PromptOptimizationExperiment(db, tracker);
      const candidates = exp.findCandidates(10);

      expect(candidates.length).toBe(1);
      expect(candidates[0]!.skill.id).toBe(id);
      expect(candidates[0]!.skill.text).toBe("a skill that works sometimes");
      expect(candidates[0]!.metrics.totalExecutions).toBe(7);
      expect(candidates[0]!.metrics.successRate).toBeCloseTo(4 / 7, 2);
    });

    it("excludes skills with very high success rate (>0.9)", () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 19, 1); // 95% success
      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(10)).toEqual([]);
    });

    it("excludes skills with very low success rate (<0.3)", () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 1, 9); // 10% success
      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(10)).toEqual([]);
    });

    it("prioritizes higher opportunity scores", () => {
      const highOp = insertSkillChunk(db, { importance_score: 0.9 });
      seedExecutions(db, highOp, 3, 4); // ~43% success, high importance

      const lowOp = insertSkillChunk(db, { importance_score: 0.3 });
      seedExecutions(db, lowOp, 5, 3); // ~63% success, low importance

      const exp = new PromptOptimizationExperiment(db, tracker);
      const candidates = exp.findCandidates(10);

      expect(candidates.length).toBe(2);
      // Higher opportunity = lower success rate × higher importance
      expect(candidates[0]!.skill.id).toBe(highOp);
    });

    it("respects maxChunks limit", () => {
      for (let i = 0; i < 5; i++) {
        const id = insertSkillChunk(db, { importance_score: 0.5 + i * 0.05 });
        seedExecutions(db, id, 4, 3);
      }

      const exp = new PromptOptimizationExperiment(db, tracker);
      expect(exp.findCandidates(2).length).toBe(2);
    });

    it("returns correct OptimizationCandidate shape", () => {
      const id = insertSkillChunk(db, {
        text: "format json output",
        skill_category: "formatting",
        importance_score: 0.7,
      });
      seedExecutions(db, id, 5, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      expect(candidate).toBeDefined();
      expect(candidate!.skill.id).toBe(id);
      expect(candidate!.skill.text).toBe("format json output");
      expect(candidate!.skill.skill_category).toBe("formatting");
      expect(candidate!.skill.importance_score).toBe(0.7);
      expect(candidate!.metrics).toHaveProperty("totalExecutions");
      expect(candidate!.metrics).toHaveProperty("successRate");
      expect(candidate!.metrics).toHaveProperty("errorBreakdown");
    });
  });

  describe("optimize", () => {
    it("generates mutations from LLM response", async () => {
      const id = insertSkillChunk(db, {
        text: "original skill",
        importance_score: 0.7,
      });
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const results = await exp.optimize(candidate!, async () => MUTATION_LLM_RESPONSE);

      expect(results.length).toBe(3);
      expect(results[0]!.content).toBe("improved version 1");
      expect(results[0]!.confidence).toBeCloseTo(0.8);
      expect(results[0]!.opportunityScore).toBeGreaterThan(0);
      expect(typeof results[0]!.strategy).toBe("string");
    });

    it("returns empty array when LLM returns garbage", async () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const results = await exp.optimize(candidate!, async () => "not json");
      expect(results).toEqual([]);
    });

    it("returns empty array when LLM throws", async () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const results = await exp.optimize(candidate!, async () => {
        throw new Error("LLM error");
      });
      expect(results).toEqual([]);
    });

    it("handles markdown-wrapped JSON", async () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const wrapped = "```json\n" + MUTATION_LLM_RESPONSE + "\n```";
      const results = await exp.optimize(candidate!, async () => wrapped);
      expect(results.length).toBe(3);
    });

    it("clamps confidence values to 0-1", async () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const extreme = JSON.stringify([
        { content: "test", confidence: 5.0 },
        { content: "test2", confidence: -1.0 },
      ]);
      const results = await exp.optimize(candidate!, async () => extreme);
      expect(results[0]!.confidence).toBeLessThanOrEqual(1);
      expect(results[1]!.confidence).toBeGreaterThanOrEqual(0);
    });

    it("includes strategy name in results", async () => {
      const id = insertSkillChunk(db);
      seedExecutions(db, id, 4, 3);

      const exp = new PromptOptimizationExperiment(db, tracker);
      const [candidate] = exp.findCandidates(1);

      const results = await exp.optimize(candidate!, async () => MUTATION_LLM_RESPONSE);
      // Strategy should be one of the valid strategies
      const validStrategies = [
        "generic",
        "error_driven",
        "adversarial",
        "compositional",
        "parametric",
      ];
      expect(validStrategies).toContain(results[0]!.strategy);
    });
  });
});
