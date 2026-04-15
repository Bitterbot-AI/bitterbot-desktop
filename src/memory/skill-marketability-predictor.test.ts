import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi } from "vitest";
import {
  buildPredictionPrompt,
  ensureMarketabilitySchema,
  heuristicScore,
  parseLlmResponse,
  recommendedAction,
  SkillMarketabilityPredictor,
  type PredictionInput,
} from "./skill-marketability-predictor.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureMarketabilitySchema(db);
  return db;
}

function makeInput(overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    skillId: "skill-1",
    contentHash: "hash-1",
    name: "example-skill",
    description: "Test skill for predictor",
    category: "docs",
    contentSample: "x".repeat(2000),
    tags: ["test"],
    ...overrides,
  };
}

describe("skill-marketability-predictor", () => {
  describe("heuristicScore", () => {
    it("returns a value in [0.1, 0.9]", () => {
      const score = heuristicScore(makeInput());
      expect(score).toBeGreaterThanOrEqual(0.1);
      expect(score).toBeLessThanOrEqual(0.9);
    });

    it("boosts for matching top-demand category", () => {
      const base = heuristicScore(makeInput({ category: "weather" }));
      const boosted = heuristicScore(
        makeInput({
          category: "weather",
          marketContext: {
            topDemandCategories: [{ category: "weather", demandScore: 0.9 }],
          },
        }),
      );
      expect(boosted).toBeGreaterThan(base);
    });

    it("boosts for scarcity", () => {
      const many = heuristicScore(makeInput({ marketContext: { similarSkillCount: 20 } }));
      const few = heuristicScore(makeInput({ marketContext: { similarSkillCount: 1 } }));
      expect(few).toBeGreaterThan(many);
    });
  });

  describe("recommendedAction", () => {
    it("maps scores to action tiers", () => {
      expect(recommendedAction(0.9)).toBe("boost");
      expect(recommendedAction(0.6)).toBe("list");
      expect(recommendedAction(0.4)).toBe("keep");
      expect(recommendedAction(0.1)).toBe("skip");
    });
  });

  describe("parseLlmResponse", () => {
    it("parses a clean JSON response", () => {
      const res = parseLlmResponse(
        '{"score": 0.75, "reasoning": "strong demand signal", "recommendedAction": "boost"}',
      );
      expect(res).toEqual({
        score: 0.75,
        reasoning: "strong demand signal",
        recommendedAction: "boost",
      });
    });

    it("strips markdown code fences", () => {
      const res = parseLlmResponse(
        '```json\n{"score": 0.4, "reasoning": "meh", "recommendedAction": "keep"}\n```',
      );
      expect(res?.score).toBe(0.4);
    });

    it("clamps scores to [0, 1]", () => {
      expect(parseLlmResponse('{"score": 1.5, "reasoning": "x"}')?.score).toBe(1);
      expect(parseLlmResponse('{"score": -0.2, "reasoning": "x"}')?.score).toBe(0);
    });

    it("derives action from score when unspecified", () => {
      const res = parseLlmResponse('{"score": 0.8, "reasoning": "x"}');
      expect(res?.recommendedAction).toBe("boost");
    });

    it("returns null for malformed input", () => {
      expect(parseLlmResponse("not json")).toBeNull();
      expect(parseLlmResponse('{"no-score": 0.5}')).toBeNull();
    });
  });

  describe("buildPredictionPrompt", () => {
    it("includes all relevant context", () => {
      const prompt = buildPredictionPrompt(
        makeInput({
          marketContext: {
            topDemandCategories: [{ category: "docs", demandScore: 0.7 }],
            openBountyCount: 2,
            similarSkillCount: 3,
          },
        }),
      );
      expect(prompt).toContain("example-skill");
      expect(prompt).toContain("Category: docs");
      expect(prompt).toContain("docs (0.70)");
      expect(prompt).toContain("Open bounties in this category: 2");
      expect(prompt).toContain("Similar skills already on marketplace: 3");
      expect(prompt).toContain('"score"');
    });
  });

  describe("SkillMarketabilityPredictor", () => {
    it("is on by default and falls back to heuristic with no LLM", async () => {
      const db = createTestDb();
      const p = new SkillMarketabilityPredictor(db);
      const result = await p.predict(makeInput());
      expect(result).not.toBeNull();
      expect(result?.model).toBe("heuristic");
    });

    it("returns null when explicitly disabled", async () => {
      const db = createTestDb();
      const p = new SkillMarketabilityPredictor(db, { enabled: false });
      const result = await p.predict(makeInput());
      expect(result).toBeNull();
    });

    it("uses heuristic fallback when no LLM is configured", async () => {
      const db = createTestDb();
      const p = new SkillMarketabilityPredictor(db, { enabled: true });
      const result = await p.predict(makeInput());
      expect(result).not.toBeNull();
      expect(result?.model).toBe("heuristic");
      expect(result?.reasoning).toContain("heuristic-only");
    });

    it("calls the LLM and persists the result", async () => {
      const db = createTestDb();
      const llm = vi.fn(
        async () => '{"score": 0.85, "reasoning": "matches bounty", "recommendedAction": "boost"}',
      );
      const p = new SkillMarketabilityPredictor(db, { enabled: true }, llm);
      const result = await p.predict(makeInput({ contentHash: "hash-persist" }));
      expect(result?.score).toBe(0.85);
      expect(result?.recommendedAction).toBe("boost");
      expect(llm).toHaveBeenCalledTimes(1);

      // Cached on second call — no second LLM invocation.
      const second = await p.predict(makeInput({ contentHash: "hash-persist" }));
      expect(second?.score).toBe(0.85);
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it("respects the per-cycle budget", async () => {
      const db = createTestDb();
      const llm = vi.fn(
        async () => '{"score": 0.5, "reasoning": "ok", "recommendedAction": "keep"}',
      );
      const p = new SkillMarketabilityPredictor(db, { enabled: true, maxPerCycle: 2 }, llm);
      await p.predict(makeInput({ contentHash: "a" }));
      await p.predict(makeInput({ contentHash: "b" }));
      const third = await p.predict(makeInput({ contentHash: "c" }));
      expect(third).toBeNull();
      expect(llm).toHaveBeenCalledTimes(2);

      p.resetCycleCounter();
      const reset = await p.predict(makeInput({ contentHash: "c" }));
      expect(reset).not.toBeNull();
    });

    it("re-predicts after TTL expires", async () => {
      const db = createTestDb();
      const llm = vi.fn(
        async () => '{"score": 0.5, "reasoning": "ok", "recommendedAction": "keep"}',
      );
      const p = new SkillMarketabilityPredictor(
        db,
        { enabled: true, predictionTtlDays: 0.0001 /* ~9s */ },
        llm,
      );
      const first = await p.predict(makeInput({ contentHash: "ttl" }), {
        now: 1_000_000,
      });
      expect(first).not.toBeNull();

      p.resetCycleCounter();
      // 24 hours later — past TTL.
      const second = await p.predict(makeInput({ contentHash: "ttl" }), {
        now: 1_000_000 + 86_400_000,
      });
      expect(second).not.toBeNull();
      expect(llm).toHaveBeenCalledTimes(2);
    });

    it("pricingMultiplierFor centers at 1.0 with bounded influence", () => {
      const db = createTestDb();
      const p = new SkillMarketabilityPredictor(db, {
        enabled: true,
        pricingInfluence: 0.2,
      });
      expect(p.pricingMultiplierFor(0.5)).toBeCloseTo(1.0, 3);
      expect(p.pricingMultiplierFor(1.0)).toBeCloseTo(1.2, 3);
      expect(p.pricingMultiplierFor(0.0)).toBeCloseTo(0.8, 3);
      expect(p.pricingMultiplierFor(null)).toBe(1);
    });

    it("blendRefinerScore mixes predictor and existing score", () => {
      const db = createTestDb();
      const p = new SkillMarketabilityPredictor(db, {
        enabled: true,
        refinerBlendWeight: 0.5,
      });
      expect(p.blendRefinerScore(0.4, 0.8)).toBeCloseTo(0.6, 3);
      expect(p.blendRefinerScore(0.4, null)).toBe(0.4);
    });

    it("falls back to heuristic when LLM throws", async () => {
      const db = createTestDb();
      const llm = vi.fn(async () => {
        throw new Error("timeout");
      });
      const p = new SkillMarketabilityPredictor(db, { enabled: true }, llm);
      const result = await p.predict(makeInput());
      expect(result).not.toBeNull();
      expect(result?.model).toBe("heuristic");
    });
  });
});
