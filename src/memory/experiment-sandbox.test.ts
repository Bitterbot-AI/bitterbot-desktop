/**
 * Tests for ExperimentSandbox: PLAN-21 two-gate validation with paired bootstrap.
 *
 * Backwards-compat block keeps the legacy (v1) synthetic-scenario gate working
 * for cold-start skills. The v2 block exercises the strict gate end-to-end:
 * faithfulness short-circuit, performance paired trials, bootstrap CI accept
 * rule, low-sample fallback.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach } from "vitest";
import { bootstrapPairedCI, ExperimentSandbox, __testing } from "./experiment-sandbox.js";
import { ensureMemoryIndexSchema, ensureColumn } from "./memory-schema.js";
import {
  isHeldOut,
  listHeldOutExecutions,
  __testing as selectionTesting,
} from "./skill-execution-selection.js";

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
  // skill_executions is created lazily in the memory manager; tests build it
  // explicitly with the v2 schema (matches migrations.ts:78).
  db.exec(`CREATE TABLE IF NOT EXISTS skill_executions (
    id TEXT PRIMARY KEY,
    skill_crystal_id TEXT NOT NULL,
    session_id TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    success INTEGER,
    reward_score REAL,
    error_type TEXT,
    error_detail TEXT,
    execution_time_ms INTEGER,
    tool_calls_count INTEGER,
    user_feedback INTEGER,
    context_json TEXT DEFAULT '{}'
  )`);
  return db;
}

let execCounter = 0;
function insertSkillExecution(
  db: DatabaseSync,
  skillId: string,
  success: boolean,
  rewardScore = 0.5,
  errorType: string | null = null,
  context = "{}",
): string {
  const id = `exec-${skillId}-${++execCounter}`;
  db.prepare(
    `INSERT INTO skill_executions (id, skill_crystal_id, started_at, completed_at, success, reward_score, error_type, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    skillId,
    Date.now() - 1000,
    Date.now(),
    success ? 1 : 0,
    rewardScore,
    errorType,
    context,
  );
  return id;
}

// ── Legacy-path fixtures ────────────────────────────────────────────────────

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

// Force the legacy path for the existing assertion set by setting
// heldOutFraction=0 so no rows are reserved as held-out.
const LEGACY_OPTS = { heldOutFraction: 0 };

describe("ExperimentSandbox — legacy synthetic-scenario gate (cold start)", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createTestDb();
    execCounter = 0;
  });

  it("accepts a clearly improved mutation", async () => {
    for (let i = 0; i < 10; i++) {
      insertSkillExecution(db, SKILL.id, i < 6, 0.5);
    }
    const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE, LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "improved skill text");

    expect(verdict.accepted).toBe(true);
    expect(verdict.delta).toBeGreaterThan(0.05);
    expect(verdict.mutatedScore).toBeGreaterThan(verdict.originalScore);
    expect(verdict.testCasesRun).toBe(3);
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.reason).toContain("improves");
    expect(verdict.mode).toBe("v1-legacy");
  });

  it("rejects a mutation that degrades performance", async () => {
    for (let i = 0; i < 10; i++) {
      insertSkillExecution(db, SKILL.id, i < 7, 0.6);
    }
    const sandbox = new ExperimentSandbox(db, async () => BAD_EVAL_RESPONSE, LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "worse skill text");

    expect(verdict.accepted).toBe(false);
    expect(verdict.delta).toBeLessThan(0);
    expect(verdict.testCasesRun).toBe(2);
    expect(verdict.mode).toBe("v1-legacy");
  });

  it("returns all required MutationVerdict fields on the legacy path", async () => {
    insertSkillExecution(db, SKILL.id, true, 0.5);
    insertSkillExecution(db, SKILL.id, false, 0.3);
    const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE, LEGACY_OPTS);
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

  it("handles LLM returning garbage gracefully on the legacy path", async () => {
    insertSkillExecution(db, SKILL.id, true, 0.7);
    const sandbox = new ExperimentSandbox(db, async () => "not json at all", LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "test mutation");
    expect(verdict.accepted).toBe(false);
    expect(verdict.testCasesRun).toBe(1);
    expect(verdict.reason).toContain("could not be parsed");
  });

  it("handles LLM throwing an error on the legacy path", async () => {
    const sandbox = new ExperimentSandbox(
      db,
      async () => {
        throw new Error("LLM timeout");
      },
      LEGACY_OPTS,
    );
    const verdict = await sandbox.evaluate(SKILL, "test mutation");
    expect(verdict.accepted).toBe(false);
    expect(verdict.testCasesRun).toBe(1);
    expect(verdict.reason).toContain("evaluation failed");
  });

  it("handles markdown-wrapped JSON response on the legacy path", async () => {
    insertSkillExecution(db, SKILL.id, true, 0.5);
    const wrappedResponse = "```json\n" + GOOD_EVAL_RESPONSE + "\n```";
    const sandbox = new ExperimentSandbox(db, async () => wrappedResponse, LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "test mutation");
    expect(verdict.testCasesRun).toBe(3);
    expect(typeof verdict.delta).toBe("number");
  });

  it("uses default baseline when no executions exist", async () => {
    const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE, LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "test mutation");
    expect(verdict.originalScore).toBeCloseTo(0.5, 1);
  });

  it("clamps all scores to 0-1 range on the legacy path", async () => {
    insertSkillExecution(db, SKILL.id, true, 0.9);
    const extremeResponse = JSON.stringify({
      criteriaScores: { edgeCases: 5.0, clarity: -1.0 },
      testScenarios: [{ scenario: "test", originalScore: 2.0, mutatedScore: -0.5 }],
      overallMutatedScore: 1.5,
      reasoning: "extreme values",
    });
    const sandbox = new ExperimentSandbox(db, async () => extremeResponse, LEGACY_OPTS);
    const verdict = await sandbox.evaluate(SKILL, "test mutation");
    expect(verdict.mutatedScore).toBeLessThanOrEqual(1);
    expect(verdict.mutatedScore).toBeGreaterThanOrEqual(0);
    expect(verdict.confidence).toBeLessThanOrEqual(1);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0);
  });
});

// ── v2 strict-gate fixtures ────────────────────────────────────────────────

const FAITHFUL_RESPONSE = JSON.stringify({
  concepts: [
    { concept: "uses prettier", preserved: true },
    { concept: "default settings", preserved: true },
    { concept: "code formatting request", preserved: true },
  ],
});

const UNFAITHFUL_RESPONSE = JSON.stringify({
  concepts: [
    { concept: "uses prettier", preserved: true },
    { concept: "default settings", preserved: false },
    { concept: "code formatting request", preserved: false },
  ],
});

function performanceResponse(
  outcomes: Array<{ originalPassed: boolean; mutatedPassed: boolean }>,
): string {
  return JSON.stringify({
    trials: outcomes.map((o, i) => ({
      index: i + 1,
      originalPassed: o.originalPassed,
      mutatedPassed: o.mutatedPassed,
    })),
  });
}

// Deterministic RNG for bootstrap (mulberry32). Tests pin the seed.
function seededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ExperimentSandbox — v2 strict gate", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = createTestDb();
    execCounter = 0;
  });

  function llmRouter(faith: string, perf: string): (prompt: string) => Promise<string> {
    return async (prompt: string) => {
      if (prompt.includes("MUTATED:") && prompt.includes("preserved")) return faith;
      if (prompt.includes("Past execution contexts")) return perf;
      return faith;
    };
  }

  it("accepts a mutation that strictly improves on the held-out set", async () => {
    // 20 executions, all held-out (fraction=1.0). Original passed on 8.
    for (let i = 0; i < 20; i++) {
      insertSkillExecution(db, SKILL.id, i < 8, 0.5, null, JSON.stringify({ turn: i }));
    }
    // Mutation passes on 16 (recovers 8 of the 12 failures).
    const outcomes = Array.from({ length: 12 }, (_, i) => ({
      originalPassed: i < 8,
      mutatedPassed: i < 8 || i < 14, // first 8 stay, 6 of 12 failures get fixed → 14 total
    }));
    const sandbox = new ExperimentSandbox(
      db,
      llmRouter(FAITHFUL_RESPONSE, performanceResponse(outcomes)),
      { heldOutFraction: 1.0, bootstrapIterations: 200, random: seededRng(42) },
    );
    const verdict = await sandbox.evaluate(SKILL, "mutated skill text");

    expect(verdict.mode).toBe("v2-strict");
    expect(verdict.faithfulness?.passed).toBe(true);
    expect(verdict.statistical?.nPaired).toBe(12);
    expect(verdict.statistical?.delta).toBeGreaterThan(0);
    expect(verdict.statistical?.ci95Low).toBeGreaterThan(0);
    expect(verdict.accepted).toBe(true);
    expect(verdict.reason).toContain("paired bootstrap");
  });

  it("rejects a mutation whose CI includes zero", async () => {
    for (let i = 0; i < 20; i++) {
      insertSkillExecution(db, SKILL.id, i < 10, 0.5);
    }
    // Mutation: only 1-of-12 flip, the rest identical. CI will straddle zero.
    const outcomes = [
      { originalPassed: true, mutatedPassed: true },
      { originalPassed: true, mutatedPassed: true },
      { originalPassed: false, mutatedPassed: true }, // one improvement
      ...Array.from({ length: 9 }, () => ({
        originalPassed: false,
        mutatedPassed: false,
      })),
    ];
    const sandbox = new ExperimentSandbox(
      db,
      llmRouter(FAITHFUL_RESPONSE, performanceResponse(outcomes)),
      { heldOutFraction: 1.0, bootstrapIterations: 200, random: seededRng(7) },
    );
    const verdict = await sandbox.evaluate(SKILL, "marginal mutation");

    expect(verdict.mode).toBe("v2-strict");
    expect(verdict.accepted).toBe(false);
    expect(verdict.statistical?.ci95Low).toBeLessThanOrEqual(0);
    expect(verdict.reason).toContain("ci95 includes zero");
  });

  it("short-circuits on faithfulness failure before running the performance gate", async () => {
    for (let i = 0; i < 20; i++) {
      insertSkillExecution(db, SKILL.id, i < 5, 0.5);
    }
    let perfCalled = false;
    const sandbox = new ExperimentSandbox(
      db,
      async (prompt: string) => {
        if (prompt.includes("Past execution contexts")) {
          perfCalled = true;
          return performanceResponse([]);
        }
        return UNFAITHFUL_RESPONSE;
      },
      { heldOutFraction: 1.0 },
    );
    const verdict = await sandbox.evaluate(SKILL, "intent-flipped mutation");

    expect(perfCalled).toBe(false);
    expect(verdict.mode).toBe("rejected-faithfulness");
    expect(verdict.accepted).toBe(false);
    expect(verdict.faithfulness?.passed).toBe(false);
    expect(verdict.faithfulness?.missing).toContain("default settings");
    expect(verdict.reason).toContain("key concept");
  });

  it("skips the faithfulness LLM call when the mutation is a pure superset", async () => {
    for (let i = 0; i < 20; i++) {
      insertSkillExecution(db, SKILL.id, i < 6, 0.5);
    }
    const outcomes = Array.from({ length: 12 }, (_, i) => ({
      originalPassed: i < 6,
      mutatedPassed: i < 6 || i < 12, // all flip
    }));
    let faithCalled = false;
    const sandbox = new ExperimentSandbox(
      db,
      async (prompt: string) => {
        if (prompt.includes("Past execution contexts")) return performanceResponse(outcomes);
        faithCalled = true;
        return FAITHFUL_RESPONSE;
      },
      { heldOutFraction: 1.0, bootstrapIterations: 200, random: seededRng(1) },
    );
    const verdict = await sandbox.evaluate(SKILL, SKILL.text + "\n\nAlso log the result.");

    expect(faithCalled).toBe(false);
    expect(verdict.mode).toBe("v2-strict");
    expect(verdict.faithfulness?.examined.length).toBe(0);
  });

  it("falls back to legacy mode when the held-out set is too small", async () => {
    // Only 4 executions held-out — below MIN_PAIRED_FOR_BOOTSTRAP (5).
    for (let i = 0; i < 4; i++) {
      insertSkillExecution(db, SKILL.id, i < 2, 0.5);
    }
    const sandbox = new ExperimentSandbox(db, async () => GOOD_EVAL_RESPONSE, {
      heldOutFraction: 1.0,
      bootstrapIterations: 200,
    });
    const verdict = await sandbox.evaluate(SKILL, "mutated text");

    expect(verdict.mode).toBe("v1-legacy");
    expect(verdict.testCasesRun).toBe(3);
  });

  it("downgrades to low-sample fallback when judge returns too few trials", async () => {
    for (let i = 0; i < 20; i++) {
      insertSkillExecution(db, SKILL.id, i < 8, 0.5);
    }
    // Judge returns only 3 trials despite the selection set offering 12.
    const sandbox = new ExperimentSandbox(
      db,
      async (prompt: string) => {
        if (prompt.includes("Past execution contexts")) {
          return performanceResponse([
            { originalPassed: true, mutatedPassed: true },
            { originalPassed: false, mutatedPassed: true },
            { originalPassed: true, mutatedPassed: true },
          ]);
        }
        return FAITHFUL_RESPONSE;
      },
      { heldOutFraction: 1.0, bootstrapIterations: 200 },
    );
    const verdict = await sandbox.evaluate(SKILL, "shrunk mutation");

    // Performance gate returned <5 paired trials → low-sample fallback path,
    // which is the legacy gate result with the faithfulness signal preserved.
    expect(verdict.mode).toBe("v2-low-sample-fallback");
    expect(verdict.faithfulness?.passed).toBe(true);
  });
});

// ── bootstrapPairedCI unit tests ────────────────────────────────────────────

describe("bootstrapPairedCI", () => {
  it("returns zeros for an empty input", () => {
    const r = bootstrapPairedCI([], 100, seededRng(1));
    expect(r.delta).toBe(0);
    expect(r.ci95Low).toBe(0);
    expect(r.ci95High).toBe(0);
    expect(r.nPaired).toBe(0);
  });

  it("computes a CI that brackets a strongly positive delta", () => {
    // 12 trials, mutation passes on every original failure: delta = +12/12 = 1.0
    const paired = Array.from({ length: 12 }, () => ({
      executionId: "x",
      originalPassed: false,
      mutatedPassed: true,
    }));
    const r = bootstrapPairedCI(paired, 500, seededRng(99));
    expect(r.nPaired).toBe(12);
    expect(r.delta).toBe(1);
    expect(r.ci95Low).toBeGreaterThan(0.5);
    expect(r.ci95High).toBeCloseTo(1, 5);
  });

  it("returns a CI that straddles zero for ambiguous data", () => {
    const paired = [
      { executionId: "a", originalPassed: true, mutatedPassed: true },
      { executionId: "b", originalPassed: false, mutatedPassed: false },
      { executionId: "c", originalPassed: true, mutatedPassed: false },
      { executionId: "d", originalPassed: false, mutatedPassed: true },
    ];
    const r = bootstrapPairedCI(paired, 500, seededRng(3));
    expect(r.ci95Low).toBeLessThanOrEqual(0);
    expect(r.ci95High).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic under the same seed", () => {
    const paired = Array.from({ length: 8 }, (_, i) => ({
      executionId: `e${i}`,
      originalPassed: i % 2 === 0,
      mutatedPassed: i < 6,
    }));
    const a = bootstrapPairedCI(paired, 200, seededRng(42));
    const b = bootstrapPairedCI(paired, 200, seededRng(42));
    expect(a.ci95Low).toBe(b.ci95Low);
    expect(a.ci95High).toBe(b.ci95High);
  });
});

// ── Selection set determinism ────────────────────────────────────────────────

describe("skill-execution-selection", () => {
  it("isHeldOut is deterministic across calls", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `exec-${i}`);
    const a = ids.map((id) => isHeldOut(id, 0.2));
    const b = ids.map((id) => isHeldOut(id, 0.2));
    expect(a).toEqual(b);
  });

  it("isHeldOut respects the fraction parameter", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `exec-determinism-${i}`);
    const pct20 = ids.filter((id) => isHeldOut(id, 0.2)).length / ids.length;
    const pct50 = ids.filter((id) => isHeldOut(id, 0.5)).length / ids.length;
    // Tolerance of ±5pp on 1000 samples — well within bucket-quantisation noise.
    expect(pct20).toBeGreaterThan(0.13);
    expect(pct20).toBeLessThan(0.27);
    expect(pct50).toBeGreaterThan(0.43);
    expect(pct50).toBeLessThan(0.57);
  });

  it("hashBucket returns a value in [0, 99]", () => {
    for (let i = 0; i < 50; i++) {
      const b = selectionTesting.hashBucket(`anything-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it("listHeldOutExecutions filters by fraction", () => {
    const db = createTestDb();
    const skillId = "select-test";
    for (let i = 0; i < 50; i++) {
      insertSkillExecution(db, skillId, true);
    }
    const all = listHeldOutExecutions(db, skillId, { fraction: 1.0, limit: 100 });
    const none = listHeldOutExecutions(db, skillId, { fraction: 0, limit: 100 });
    const some = listHeldOutExecutions(db, skillId, { fraction: 0.2, limit: 100 });
    expect(all.length).toBe(50);
    expect(none.length).toBe(0);
    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(50);
  });

  it("listHeldOutExecutions returns rows in completion-time order, newest first", () => {
    const db = createTestDb();
    const skillId = "order-test";
    insertSkillExecution(db, skillId, true);
    insertSkillExecution(db, skillId, true);
    insertSkillExecution(db, skillId, true);
    const rows = listHeldOutExecutions(db, skillId, { fraction: 1.0, limit: 100 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.completedAt).toBeGreaterThanOrEqual(rows[i]!.completedAt);
    }
  });
});

// ── Parsing helpers ─────────────────────────────────────────────────────────

describe("parsers", () => {
  it("parseFaithfulnessResponse handles fenced JSON", () => {
    const wrapped = "```json\n" + FAITHFUL_RESPONSE + "\n```";
    const parsed = __testing.parseFaithfulnessResponse(wrapped);
    expect(parsed?.concepts.length).toBe(3);
    expect(parsed?.concepts[0]?.preserved).toBe(true);
  });

  it("parsePerformanceResponse rejects malformed input", () => {
    expect(__testing.parsePerformanceResponse("not json")).toBeNull();
    expect(__testing.parsePerformanceResponse(JSON.stringify({ trials: "wrong" }))).toBeNull();
    expect(__testing.parsePerformanceResponse(JSON.stringify({ trials: [] }))).toBeNull();
  });

  it("parsePerformanceResponse accepts a minimal valid payload", () => {
    const parsed = __testing.parsePerformanceResponse(
      performanceResponse([{ originalPassed: true, mutatedPassed: false }]),
    );
    expect(parsed?.trials.length).toBe(1);
    expect(parsed?.trials[0]?.originalPassed).toBe(true);
    expect(parsed?.trials[0]?.mutatedPassed).toBe(false);
  });
});
