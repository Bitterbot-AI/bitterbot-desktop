/**
 * Predictive marketability (PLAN-11 Gap 4).
 *
 * Current pricing is empirical only — it requires ≥3 successful executions
 * before a skill can be listed. Brand-new scraped skills sit in quarantine
 * forever unless someone exercises them. This module adds a forward-looking
 * signal: an LLM scoring "would this skill sell?" based on category
 * alignment with marketplace demand, bounty match potential, and surface
 * quality signals (length, reference count, source authority).
 *
 * The score is a soft multiplier on existing paths:
 *   - Skill refiner: blends into mutation evaluation scores (opt-in).
 *   - Skill pricing: scales rawPrice up to ±pricingInfluence (default 20%).
 *
 * Cached per content_hash in skill_marketability_predictions — predict once
 * per unique content, re-predict after predictionTtlDays (default 30).
 *
 * Safety rails:
 *   - Bounded blending so a hallucinated 0.9 from a weak LLM can't override
 *     a truly failing execution record.
 *   - Heuristic fallback when LLM call fails so the rest of the pipeline
 *     keeps working.
 *   - On by default; disable via skills.marketability.predictor.enabled = false.
 *     When no LLM is configured the heuristic path is used so no token
 *     spend occurs.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("skill-marketability-predictor");

// ── Types ──

export type PredictorConfig = {
  /** Enable the predictor. Default: true (falls back to heuristic when no LLM is configured). */
  enabled?: boolean;
  /** Minutes of the LLM budget per dream cycle. Default: 10 predictions per cycle. */
  maxPerCycle?: number;
  /** Days to cache predictions before re-predicting. Default: 30. */
  predictionTtlDays?: number;
  /** Max influence on skill pricing as a multiplier (0-1). Default: 0.2 (±20%). */
  pricingInfluence?: number;
  /** Weight of predictor score in refiner blending (0-1). Default: 0.2 (20%). */
  refinerBlendWeight?: number;
  /** Model spec "provider/model" for prediction. Default: falls back to dream model. */
  model?: string;
};

export type PredictionInput = {
  skillId: string;
  contentHash: string;
  name: string;
  description?: string;
  category?: string;
  contentSample: string;
  tags?: string[];
  /** Current marketplace context — optional, improves predictions when available. */
  marketContext?: {
    topDemandCategories?: Array<{ category: string; demandScore: number }>;
    openBountyCount?: number;
    similarSkillCount?: number;
  };
};

export type MarketabilityPrediction = {
  score: number; // 0-1
  reasoning: string;
  recommendedAction: "list" | "keep" | "boost" | "skip";
  model: string;
  predictedAt: number;
};

export type LlmCall = (prompt: string) => Promise<string>;

// ── Schema ──

export function ensureMarketabilitySchema(db: DatabaseSync): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skill_marketability_predictions (
        content_hash TEXT PRIMARY KEY,
        score REAL NOT NULL,
        reasoning TEXT,
        recommended_action TEXT NOT NULL,
        model TEXT NOT NULL,
        predicted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_marketability_predicted_at
        ON skill_marketability_predictions (predicted_at);
    `);
  } catch (err) {
    log.warn(`failed to ensure marketability schema: ${String(err)}`);
  }
}

// ── Predictor ──

export class SkillMarketabilityPredictor {
  private readonly db: DatabaseSync;
  private readonly config: Required<PredictorConfig>;
  private readonly llmCall: LlmCall | null;
  private calledThisCycle = 0;

  constructor(db: DatabaseSync, config: PredictorConfig = {}, llmCall: LlmCall | null = null) {
    this.db = db;
    this.config = {
      enabled: config.enabled ?? true,
      maxPerCycle: config.maxPerCycle ?? 10,
      predictionTtlDays: config.predictionTtlDays ?? 30,
      pricingInfluence: config.pricingInfluence ?? 0.2,
      refinerBlendWeight: config.refinerBlendWeight ?? 0.2,
      model: config.model ?? "default",
    };
    this.llmCall = llmCall;
    ensureMarketabilitySchema(db);
  }

  /** Reset per-cycle counter (call at dream-cycle start). */
  resetCycleCounter(): void {
    this.calledThisCycle = 0;
  }

  /** Soft multiplier applied to rawPrice. Centered at 1.0 (no change). */
  pricingMultiplierFor(score: number | null): number {
    if (score == null || !Number.isFinite(score)) {
      return 1;
    }
    // Linear mapping: score 0 → 1-influence, score 1 → 1+influence, score 0.5 → 1.
    const centered = score - 0.5; // [-0.5, +0.5]
    return Math.max(0.1, 1 + centered * 2 * this.config.pricingInfluence);
  }

  /** Blend predictor score into an existing [0-1] quality score used by the refiner. */
  blendRefinerScore(existing: number, predictorScore: number | null): number {
    if (predictorScore == null || !Number.isFinite(predictorScore)) {
      return existing;
    }
    const w = this.config.refinerBlendWeight;
    return Math.max(0, Math.min(1, existing * (1 - w) + predictorScore * w));
  }

  /**
   * Read a cached prediction (returns null if missing, stale, or disabled).
   */
  getCached(contentHash: string, now: number = Date.now()): MarketabilityPrediction | null {
    if (!this.config.enabled) {
      return null;
    }
    try {
      const row = this.db
        .prepare(
          `SELECT score, reasoning, recommended_action, model, predicted_at
           FROM skill_marketability_predictions
           WHERE content_hash = ?`,
        )
        .get(contentHash) as
        | {
            score: number;
            reasoning: string | null;
            recommended_action: string;
            model: string;
            predicted_at: number;
          }
        | undefined;
      if (!row) {
        return null;
      }
      const staleAfter = row.predicted_at + this.config.predictionTtlDays * 86_400_000;
      if (staleAfter < now) {
        return null;
      }
      return {
        score: row.score,
        reasoning: row.reasoning ?? "",
        recommendedAction:
          (row.recommended_action as MarketabilityPrediction["recommendedAction"]) ?? "keep",
        model: row.model,
        predictedAt: row.predicted_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Predict marketability. Returns cached value when available, otherwise
   * calls the LLM and stores the result. Respects maxPerCycle so bursty
   * refiner passes don't blow the LLM budget.
   */
  async predict(
    input: PredictionInput,
    opts: { now?: number; force?: boolean } = {},
  ): Promise<MarketabilityPrediction | null> {
    if (!this.config.enabled) {
      return null;
    }
    const now = opts.now ?? Date.now();

    if (!opts.force) {
      const cached = this.getCached(input.contentHash, now);
      if (cached) {
        return cached;
      }
    }

    if (this.calledThisCycle >= this.config.maxPerCycle) {
      log.debug(`skipping prediction for ${input.skillId}: cycle budget exhausted`);
      return null;
    }
    if (!this.llmCall) {
      // No LLM — fall back to heuristic so downstream code still sees a score.
      const heuristic = heuristicScore(input);
      const prediction = {
        score: heuristic,
        reasoning: "heuristic-only (no LLM configured)",
        recommendedAction: recommendedAction(heuristic),
        model: "heuristic",
        predictedAt: now,
      };
      this.persist(input.contentHash, prediction);
      return prediction;
    }

    this.calledThisCycle += 1;
    const prompt = buildPredictionPrompt(input);
    try {
      const raw = await this.llmCall(prompt);
      const parsed = parseLlmResponse(raw);
      if (!parsed) {
        log.debug(`prediction parse failed for ${input.skillId}, falling back to heuristic`);
        const heuristic = heuristicScore(input);
        const prediction: MarketabilityPrediction = {
          score: heuristic,
          reasoning: "LLM response unparseable, using heuristic",
          recommendedAction: recommendedAction(heuristic),
          model: this.config.model,
          predictedAt: now,
        };
        this.persist(input.contentHash, prediction);
        return prediction;
      }
      const prediction: MarketabilityPrediction = {
        score: parsed.score,
        reasoning: parsed.reasoning,
        recommendedAction: parsed.recommendedAction,
        model: this.config.model,
        predictedAt: now,
      };
      this.persist(input.contentHash, prediction);
      return prediction;
    } catch (err) {
      log.warn(
        `prediction LLM call failed for ${input.skillId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const heuristic = heuristicScore(input);
      const prediction: MarketabilityPrediction = {
        score: heuristic,
        reasoning: "LLM error, using heuristic",
        recommendedAction: recommendedAction(heuristic),
        model: "heuristic",
        predictedAt: now,
      };
      this.persist(input.contentHash, prediction);
      return prediction;
    }
  }

  private persist(contentHash: string, prediction: MarketabilityPrediction): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO skill_marketability_predictions
           (content_hash, score, reasoning, recommended_action, model, predicted_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          contentHash,
          prediction.score,
          prediction.reasoning,
          prediction.recommendedAction,
          prediction.model,
          prediction.predictedAt,
        );
    } catch (err) {
      log.debug(`persist failed: ${String(err)}`);
    }
  }
}

// ── Helpers ──

/**
 * Heuristic score used when the LLM is unavailable. Deliberately simple:
 * surface signals only. Always returns a value in [0.1, 0.9] so it doesn't
 * score stronger than LLM predictions normally would.
 */
export function heuristicScore(input: PredictionInput): number {
  let score = 0.4; // Baseline — default untrusted score.

  // Category alignment with market demand
  if (input.marketContext?.topDemandCategories) {
    const match = input.marketContext.topDemandCategories.find(
      (c) => c.category === input.category,
    );
    if (match) {
      score += match.demandScore * 0.3;
    }
  }

  // Bounty match proxy
  if ((input.marketContext?.openBountyCount ?? 0) > 0) {
    score += 0.1;
  }

  // Scarcity — fewer similar skills = more valuable
  const similar = input.marketContext?.similarSkillCount;
  if (typeof similar === "number") {
    if (similar <= 2) score += 0.15;
    else if (similar <= 5) score += 0.05;
  }

  // Content length surface signal
  const lenKb = input.contentSample.length / 1024;
  if (lenKb > 5) score += 0.05;
  if (lenKb > 15) score += 0.05;

  return Math.max(0.1, Math.min(0.9, score));
}

export function recommendedAction(score: number): MarketabilityPrediction["recommendedAction"] {
  if (score >= 0.75) return "boost";
  if (score >= 0.55) return "list";
  if (score >= 0.3) return "keep";
  return "skip";
}

export function buildPredictionPrompt(input: PredictionInput): string {
  const lines: string[] = [];
  lines.push("You are a marketplace analyst evaluating AI skills for commercial viability.");
  lines.push("");
  lines.push("Score this skill on how likely it is to be purchased by other agents.");
  lines.push("Consider: demand alignment, source authority, completeness, scarcity.");
  lines.push("");
  lines.push("Skill:");
  lines.push(`  Name: ${input.name}`);
  if (input.description) {
    lines.push(`  Description: ${input.description}`);
  }
  if (input.category) {
    lines.push(`  Category: ${input.category}`);
  }
  if (input.tags && input.tags.length > 0) {
    lines.push(`  Tags: ${input.tags.join(", ")}`);
  }
  lines.push("");
  lines.push("Content (excerpt):");
  lines.push(input.contentSample.slice(0, 2000));
  lines.push("");

  const ctx = input.marketContext;
  if (ctx) {
    lines.push("Marketplace context:");
    if (ctx.topDemandCategories && ctx.topDemandCategories.length > 0) {
      lines.push(
        `  Top demand: ${ctx.topDemandCategories
          .map((c) => `${c.category} (${c.demandScore.toFixed(2)})`)
          .join(", ")}`,
      );
    }
    if (typeof ctx.openBountyCount === "number" && ctx.openBountyCount > 0) {
      lines.push(`  Open bounties in this category: ${ctx.openBountyCount}`);
    }
    if (typeof ctx.similarSkillCount === "number") {
      lines.push(`  Similar skills already on marketplace: ${ctx.similarSkillCount}`);
    }
    lines.push("");
  }

  lines.push("Respond with ONLY a JSON object matching this shape:");
  lines.push(
    '{"score": <0.0-1.0>, "reasoning": "<one-sentence rationale>", "recommendedAction": "list" | "keep" | "boost" | "skip"}',
  );
  lines.push("");
  lines.push("Actions:");
  lines.push("  boost: high confidence, allocate more cycles to mutations");
  lines.push("  list:  ready for marketplace despite no execution history");
  lines.push("  keep:  worth retaining; wait for execution signal");
  lines.push("  skip:  low value, consider pruning early");

  return lines.join("\n");
}

export function parseLlmResponse(raw: string): {
  score: number;
  reasoning: string;
  recommendedAction: MarketabilityPrediction["recommendedAction"];
} | null {
  // Strip code fences if present.
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Try to find the first JSON object in the response.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const score = typeof parsed.score === "number" ? parsed.score : null;
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    const rawAction = typeof parsed.recommendedAction === "string" ? parsed.recommendedAction : "";
    if (score == null || !Number.isFinite(score)) {
      return null;
    }
    const clampedScore = Math.max(0, Math.min(1, score));
    const action: MarketabilityPrediction["recommendedAction"] = [
      "list",
      "keep",
      "boost",
      "skip",
    ].includes(rawAction as MarketabilityPrediction["recommendedAction"])
      ? (rawAction as MarketabilityPrediction["recommendedAction"])
      : recommendedAction(clampedScore);
    return { score: clampedScore, reasoning, recommendedAction: action };
  } catch {
    return null;
  }
}
