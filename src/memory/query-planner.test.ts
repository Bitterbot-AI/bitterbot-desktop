import { beforeEach, describe, expect, it } from "vitest";
import { _clearQueryPlanCache, planQuery, planQueryHeuristic } from "./query-planner.js";

describe("query-planner heuristic", () => {
  beforeEach(() => {
    _clearQueryPlanCache();
  });

  it("extracts capitalized entity runs", () => {
    const plan = planQueryHeuristic("Who works on Bitterbot Memory System with Victor Gil?");
    expect(plan.explicitEntities).toContain("Bitterbot Memory System");
    expect(plan.explicitEntities).toContain("Victor Gil");
    expect(plan.source).toBe("heuristic");
  });

  it("classifies answer type from interrogative", () => {
    expect(planQueryHeuristic("How do I configure logging?").answerType).toBe("procedure");
    expect(planQueryHeuristic("Compare Postgres and SQLite").answerType).toBe("comparison");
    expect(planQueryHeuristic("Is the build green?").answerType).toBe("yesno");
    expect(planQueryHeuristic("List the open PRs").answerType).toBe("list");
    expect(planQueryHeuristic("Explain RRF fusion").answerType).toBe("explanation");
    expect(planQueryHeuristic("Who wrote the dream engine?").answerType).toBe("factual");
    expect(planQueryHeuristic("Just rambling text").answerType).toBe("unknown");
  });

  it("captures hard constraints (quotes, dates, paths)", () => {
    const plan = planQueryHeuristic(`Find "exact phrase" in src/memory/manager.ts from 2026-04-25`);
    expect(plan.hardConstraints).toContain("exact phrase");
    expect(plan.hardConstraints).toContain("2026-04-25");
    expect(plan.hardConstraints).toContain("src/memory/manager.ts");
  });

  it("generates multiple pseudo-queries that are non-empty and distinct", () => {
    const plan = planQueryHeuristic("How do I compare Foo and Bar engines?");
    expect(plan.pseudoQueries.length).toBeGreaterThan(1);
    const lowered = plan.pseudoQueries.map((q) => q.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it("returns an empty-but-valid plan for empty input", () => {
    const plan = planQueryHeuristic("");
    expect(plan.explicitEntities).toEqual([]);
    expect(plan.answerType).toBe("unknown");
    expect(plan.pseudoQueries).toEqual([]);
  });
});

describe("query-planner LLM path", () => {
  beforeEach(() => {
    _clearQueryPlanCache();
  });

  it("parses well-formed JSON response", async () => {
    const llmCall = async () =>
      JSON.stringify({
        explicitEntities: ["Bitterbot"],
        aliases: ["bb"],
        conceptualRelations: ["depends_on"],
        hardConstraints: ["2026-Q2"],
        answerType: "explanation",
        pseudoQueries: ["bitterbot overview", "what is bitterbot"],
      });
    const plan = await planQuery("Tell me about Bitterbot", { llmCall, noCache: true });
    expect(plan.source).toBe("llm");
    expect(plan.explicitEntities).toEqual(["Bitterbot"]);
    expect(plan.aliases).toEqual(["bb"]);
    expect(plan.conceptualRelations).toEqual(["depends_on"]);
    expect(plan.hardConstraints).toEqual(["2026-Q2"]);
    expect(plan.answerType).toBe("explanation");
    expect(plan.pseudoQueries.length).toBeGreaterThan(1);
  });

  it("strips markdown fences around JSON", async () => {
    const llmCall = async () =>
      '```json\n{"explicitEntities":["X"],"aliases":[],"conceptualRelations":[],"hardConstraints":[],"answerType":"factual","pseudoQueries":["x"]}\n```';
    const plan = await planQuery("about X", { llmCall, noCache: true });
    expect(plan.source).toBe("llm");
    expect(plan.explicitEntities).toEqual(["X"]);
  });

  it("falls back to heuristic when LLM throws", async () => {
    const llmCall = async () => {
      throw new Error("rate-limited");
    };
    const plan = await planQuery("Who Wrote Bitterbot?", { llmCall, noCache: true });
    expect(plan.source).toBe("heuristic");
    expect(plan.explicitEntities).toContain("Bitterbot");
  });

  it("falls back to heuristic on malformed JSON", async () => {
    const llmCall = async () => "not even json at all";
    const plan = await planQuery("Capitalized Thing here", {
      llmCall,
      noCache: true,
    });
    expect(plan.source).toBe("heuristic");
    expect(plan.explicitEntities).toContain("Capitalized Thing");
  });

  it("enriches an LLM plan that returned zero entities", async () => {
    const llmCall = async () =>
      JSON.stringify({
        explicitEntities: [],
        aliases: [],
        conceptualRelations: [],
        hardConstraints: [],
        answerType: "unknown",
        pseudoQueries: ["raw"],
      });
    const plan = await planQuery("Find Alice in 2026-Q1", { llmCall, noCache: true });
    // LLM produced source="llm" but extras came from heuristic enrichment.
    expect(plan.source).toBe("llm");
    expect(plan.explicitEntities).toContain("Alice");
    expect(plan.hardConstraints).toContain("2026-Q1");
  });

  it("caches plans across calls with the same query", async () => {
    let callCount = 0;
    const llmCall = async () => {
      callCount++;
      return JSON.stringify({
        explicitEntities: ["A"],
        aliases: [],
        conceptualRelations: [],
        hardConstraints: [],
        answerType: "factual",
        pseudoQueries: ["a"],
      });
    };
    const p1 = await planQuery("same query", { llmCall });
    const p2 = await planQuery("same query", { llmCall });
    expect(callCount).toBe(1);
    expect(p1.source).toBe("llm");
    expect(p2.source).toBe("cache");
  });

  it("respects noCache option", async () => {
    let callCount = 0;
    const llmCall = async () => {
      callCount++;
      return JSON.stringify({
        explicitEntities: ["Z"],
        aliases: [],
        conceptualRelations: [],
        hardConstraints: [],
        answerType: "factual",
        pseudoQueries: ["z"],
      });
    };
    await planQuery("repeated", { llmCall, noCache: true });
    await planQuery("repeated", { llmCall, noCache: true });
    expect(callCount).toBe(2);
  });
});
