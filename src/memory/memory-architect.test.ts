import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  activeRuleTexts,
  countActiveRules,
  harvestConstructionFeedback,
  insertRule,
  loadActiveRules,
  pairedBootstrap,
  parseProposedRules,
  retireRule,
  runArchitectCycle,
  validateCandidates,
} from "./memory-architect.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { runMigrations } from "./migrations.js";
import { buildExtractionPrompt } from "./session-extractor.js";

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

function seedFeedback(db: DatabaseSync, n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO memory_audit_log (id, chunk_id, event, timestamp, actor, metadata)
       VALUES (?, NULL, 'construction_feedback', ?, 'coverage_diagnostics', ?)`,
    ).run(
      crypto.randomUUID(),
      1000 + i,
      JSON.stringify({
        comparison_type: "exogenous",
        question: `which date was event ${i}`,
        root_cause_summary: "date lost during construction",
      }),
    );
  }
}

// Stub LLM: returns proposed rules for the propose prompt, and a faithful
// extraction for the extraction prompt. `factCountWithRule` controls how many
// facts the candidate (rule-bearing) extraction yields vs the baseline.
function makeStubLlm(opts: { baseFacts: number; candFacts: number; rule?: string }) {
  const ruleText = opts.rule ?? "Always record exact dates and relative ordering";
  return async (prompt: string): Promise<string> => {
    if (prompt.includes("Propose 1-4 NEW")) {
      return JSON.stringify([{ rule: ruleText, category: "temporal" }]);
    }
    // extraction prompt — line 1 of the transcript contains the fact words.
    const hasRule = prompt.includes(ruleText);
    const k = hasRule ? opts.candFacts : opts.baseFacts;
    const facts = Array.from({ length: k }, () => ({
      text: "alpha bravo charlie",
      layer: "world_fact",
      confidence: 0.9,
      lines: [1],
    }));
    return JSON.stringify({
      facts,
      handover: { purpose: "p", milestones: [], decisions: [], blockers: [], nextSteps: [] },
    });
  };
}

const HELD_OUT = [{ id: "s1", content: "User: alpha bravo charlie delta\nAssistant: ok" }];

describe("rule store", () => {
  it("inserts, loads, counts, and retires rules", () => {
    const db = openTestDb();
    expect(countActiveRules(db)).toBe(0);
    const id = insertRule(db, { ruleText: "Preserve exact dates", category: "temporal", now: 1 });
    insertRule(db, { ruleText: "Keep entity identity", category: "identity", now: 2 });
    expect(countActiveRules(db)).toBe(2);
    expect(activeRuleTexts(db)).toEqual(["Preserve exact dates", "Keep entity identity"]);
    retireRule(db, id);
    expect(countActiveRules(db)).toBe(1);
    expect(loadActiveRules(db)[0].ruleText).toBe("Keep entity identity");
  });
});

describe("harvestConstructionFeedback", () => {
  it("reads construction_feedback audit events", () => {
    const db = openTestDb();
    seedFeedback(db, 3);
    const fb = harvestConstructionFeedback(db);
    expect(fb).toHaveLength(3);
    expect(fb[0].comparisonType).toBe("exogenous");
    expect(fb[0].rootCauseSummary).toContain("date lost");
  });
});

describe("parseProposedRules", () => {
  it("parses a JSON array, strips fences, dedupes, caps at 4", () => {
    const raw =
      "```json\n" +
      JSON.stringify([
        { rule: "Record exact dates", category: "temporal" },
        { rule: "Record exact dates" },
        { rule: "x" },
        { rule: "Preserve identity chains", category: "identity" },
      ]) +
      "\n```";
    const out = parseProposedRules(raw);
    expect(out.map((r) => r.ruleText)).toEqual(["Record exact dates", "Preserve identity chains"]);
  });
  it("tolerates garbage", () => {
    expect(parseProposedRules("not json")).toEqual([]);
    expect(parseProposedRules("{}")).toEqual([]);
  });
});

describe("pairedBootstrap", () => {
  it("positive deltas yield a positive lower CI", () => {
    const r = pairedBootstrap([1, 1, 2, 1, 2], 500, () => 0.5);
    expect(r.meanDelta).toBeGreaterThan(0);
    expect(r.ci95Low).toBeGreaterThan(0);
  });
  it("negative deltas yield a negative mean", () => {
    const r = pairedBootstrap([-1, -1, -2], 500, () => 0.5);
    expect(r.meanDelta).toBeLessThan(0);
  });
  it("empty is zero", () => {
    expect(pairedBootstrap([])).toEqual({ meanDelta: 0, ci95Low: 0 });
  });
});

describe("validateCandidates", () => {
  it("accepts a candidate that improves faithful coverage", async () => {
    const v = await validateCandidates({
      llmCall: makeStubLlm({ baseFacts: 1, candFacts: 2 }),
      heldOut: HELD_OUT,
      baselineRules: [],
      candidates: [{ ruleText: "Always record exact dates and relative ordering" }],
      rng: () => 0.5,
    });
    expect(v.accepted).toBe(true);
    expect(v.meanDelta).toBeGreaterThan(0);
  });
  it("rejects a candidate that regresses coverage", async () => {
    const v = await validateCandidates({
      llmCall: makeStubLlm({ baseFacts: 2, candFacts: 0 }),
      heldOut: HELD_OUT,
      baselineRules: [],
      candidates: [{ ruleText: "Always record exact dates and relative ordering" }],
      rng: () => 0.5,
    });
    expect(v.accepted).toBe(false);
    expect(v.meanDelta).toBeLessThan(0);
  });
});

describe("runArchitectCycle", () => {
  it("skips when feedback is below threshold", async () => {
    const db = openTestDb();
    seedFeedback(db, 2);
    const res = await runArchitectCycle({
      db,
      llmCall: makeStubLlm({ baseFacts: 1, candFacts: 2 }),
      heldOut: HELD_OUT,
      minFeedback: 5,
    });
    expect(res.ran).toBe(false);
    expect(res.reason).toBe("insufficient-feedback");
    expect(countActiveRules(db)).toBe(0);
  });

  it("harvests, proposes, validates, and promotes a winning rule", async () => {
    const db = openTestDb();
    seedFeedback(db, 6);
    const res = await runArchitectCycle({
      db,
      llmCall: makeStubLlm({ baseFacts: 1, candFacts: 2 }),
      heldOut: HELD_OUT,
      minFeedback: 5,
      rng: () => 0.5,
    });
    expect(res.ran).toBe(true);
    expect(res.promoted).toBe(1);
    expect(countActiveRules(db)).toBe(1);
    expect(activeRuleTexts(db)[0]).toContain("exact dates");
  });

  it("does not promote a rule that fails validation", async () => {
    const db = openTestDb();
    seedFeedback(db, 6);
    const res = await runArchitectCycle({
      db,
      llmCall: makeStubLlm({ baseFacts: 2, candFacts: 0 }),
      heldOut: HELD_OUT,
      minFeedback: 5,
      rng: () => 0.5,
    });
    expect(res.promoted).toBe(0);
    expect(res.reason).toBe("validation-rejected");
    expect(countActiveRules(db)).toBe(0);
  });
});

describe("buildExtractionPrompt rule injection", () => {
  it("injects the Learned Construction Rules section when rules exist", () => {
    const prompt = buildExtractionPrompt("User: hi", 10, undefined, ["Always record exact dates"]);
    expect(prompt).toContain("## Learned Construction Rules");
    expect(prompt).toContain("- Always record exact dates");
  });
  it("omits the section when there are no rules", () => {
    const prompt = buildExtractionPrompt("User: hi", 10, undefined, []);
    expect(prompt).not.toContain("Learned Construction Rules");
  });
});
