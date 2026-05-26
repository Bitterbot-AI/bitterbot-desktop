/**
 * ExperimentSandbox: validation gate for skill mutations (PLAN-21 Phase A).
 *
 * The v2 gate runs in two stages and produces a paired-bootstrap CI on real
 * held-out executions:
 *
 *   1. Faithfulness gate. One LLM-judge call extracts the original skill's
 *      key operational concepts and checks that each survives in the mutation.
 *      A mutation that flips intent is rejected here, before the heavier
 *      performance gate runs.
 *
 *   2. Performance gate. The held-out selection set (deterministic 20% of
 *      `skill_executions` for this skill) is replayed in a single batched LLM
 *      call that scores each trial under both versions. Paired binary outcomes
 *      feed a bootstrap CI on the per-trial delta; we accept the mutation only
 *      when `ci95Low > 0`.
 *
 * When there are fewer than `MIN_PAIRED_FOR_BOOTSTRAP` held-out executions we
 * fall back to the legacy synthetic-scenario path. That keeps fresh skills
 * (cold start) on the existing rails until they accumulate enough real
 * trajectories for the strict gate.
 *
 * Backwards compatibility: the `MutationVerdict` shape adds `faithfulness`,
 * `statistical`, and `mode` fields without removing or renaming any of the
 * pre-existing fields, so dream-engine and existing tests keep compiling.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_HELD_OUT_FRACTION,
  type HeldOutExecution,
  listHeldOutExecutions,
  MIN_PAIRED_FOR_BOOTSTRAP,
} from "./skill-execution-selection.js";

const log = createSubsystemLogger("memory/experiment-sandbox");

/** Minimum legacy delta required for the cold-start fallback to accept. */
const ACCEPTANCE_THRESHOLD = 0.05;

/** Number of bootstrap resamples for the paired CI. Trades stability vs cost. */
const BOOTSTRAP_ITERATIONS = 2000;

/** Maximum past-execution trials included in the performance-gate prompt. */
const MAX_PERFORMANCE_TRIALS = 12;

/** Maximum chars per context_json blob in the performance-gate prompt. */
const MAX_CONTEXT_CHARS = 400;

export type SandboxMode =
  | "v2-strict"
  | "v2-low-sample-fallback"
  | "v1-legacy"
  | "rejected-faithfulness";

export interface FaithfulnessResult {
  /** True when every extracted concept survives in the mutation. */
  passed: boolean;
  /** Concepts the judge flagged as missing in the mutation. */
  missing: ReadonlyArray<string>;
  /** Concepts the judge extracted from the original (for audit / logging). */
  examined: ReadonlyArray<string>;
}

export interface StatisticalResult {
  /** Mean per-trial delta (`mutatedPass` − `originalPass`), in [-1, 1]. */
  delta: number;
  /** Lower bound of the 95% CI on the per-trial delta. */
  ci95Low: number;
  /** Upper bound of the 95% CI on the per-trial delta. */
  ci95High: number;
  /** Number of paired trials feeding the bootstrap. */
  nPaired: number;
}

export interface MutationVerdict {
  /** Whether the mutation outperforms the original by the active accept rule. */
  accepted: boolean;
  /** Statistical confidence in the verdict (0–1). */
  confidence: number;
  /** Score improvement: mutatedScore − originalScore. Can be negative. */
  delta: number;
  /** Number of test scenarios evaluated. Counts toward the dream LLM budget. */
  testCasesRun: number;
  /** Baseline performance score (0–1). */
  originalScore: number;
  /** Mutation performance score (0–1). */
  mutatedScore: number;
  /** Human-readable explanation of the verdict. */
  reason: string;
  /** Which acceptance path produced this verdict. */
  mode?: SandboxMode;
  /** Faithfulness-gate outcome (omitted on cold-start / legacy path). */
  faithfulness?: FaithfulnessResult;
  /** Bootstrap CI envelope (omitted on cold-start / legacy path). */
  statistical?: StatisticalResult;
}

export interface ExperimentSandboxOptions {
  /** Override the default 20% held-out fraction (tests use 1.0). */
  heldOutFraction?: number;
  /** Override the bootstrap iteration count (tests use small values for speed). */
  bootstrapIterations?: number;
  /** Override the random source used for the bootstrap (tests pin determinism). */
  random?: () => number;
}

export class ExperimentSandbox {
  private readonly heldOutFraction: number;
  private readonly bootstrapIters: number;
  private readonly rng: () => number;

  constructor(
    private readonly db: DatabaseSync,
    private readonly llmCall: (prompt: string) => Promise<string>,
    options: ExperimentSandboxOptions = {},
  ) {
    this.heldOutFraction = options.heldOutFraction ?? DEFAULT_HELD_OUT_FRACTION;
    this.bootstrapIters = options.bootstrapIterations ?? BOOTSTRAP_ITERATIONS;
    this.rng = options.random ?? Math.random;
  }

  /**
   * Evaluate a proposed skill mutation against the original. Runs the
   * faithfulness gate first; on failure, short-circuits before the
   * performance gate is invoked. Falls back to the legacy synthetic-scenario
   * path when the held-out selection set has fewer than
   * `MIN_PAIRED_FOR_BOOTSTRAP` rows.
   */
  async evaluate(
    skill: {
      id: string;
      text: string;
      skill_category: string | null;
      importance_score: number;
    },
    mutatedText: string,
  ): Promise<MutationVerdict> {
    // ── Stage 1: held-out selection set ─────────────────────────────────────
    const selectionSet = listHeldOutExecutions(this.db, skill.id, {
      fraction: this.heldOutFraction,
      limit: MAX_PERFORMANCE_TRIALS,
    });

    if (selectionSet.length < MIN_PAIRED_FOR_BOOTSTRAP) {
      // Cold start: no real held-out trajectories yet. Fall back to the
      // legacy synthetic-scenario gate (kept for backwards compatibility).
      return this.legacyEvaluate(skill, mutatedText, "v1-legacy");
    }

    // ── Stage 2: faithfulness gate ──────────────────────────────────────────
    let faithfulness: FaithfulnessResult;
    try {
      faithfulness = await this.runFaithfulnessGate(skill.text, mutatedText);
    } catch (err) {
      log.debug(`faithfulness gate failed: ${String(err)}`);
      return this.legacyEvaluate(skill, mutatedText, "v1-legacy");
    }

    if (!faithfulness.passed) {
      const reason =
        `mutation lost ${faithfulness.missing.length} of ${faithfulness.examined.length} ` +
        `key concept${faithfulness.examined.length === 1 ? "" : "s"}: ` +
        faithfulness.missing.slice(0, 3).join(", ");
      return {
        accepted: false,
        confidence: 0.9,
        delta: 0,
        testCasesRun: 1,
        originalScore: 0.5,
        mutatedScore: 0.5,
        reason,
        mode: "rejected-faithfulness",
        faithfulness,
      };
    }

    // ── Stage 3: performance gate (paired trials) ───────────────────────────
    let paired: ReadonlyArray<PairedOutcome>;
    try {
      paired = await this.runPerformanceGate(skill.text, mutatedText, selectionSet);
    } catch (err) {
      log.debug(`performance gate failed: ${String(err)}`);
      return this.legacyEvaluate(skill, mutatedText, "v1-legacy");
    }

    if (paired.length < MIN_PAIRED_FOR_BOOTSTRAP) {
      // The LLM returned fewer trials than the selection set requested — fall
      // back without giving up the faithfulness signal.
      const legacy = await this.legacyEvaluate(skill, mutatedText, "v2-low-sample-fallback");
      return { ...legacy, faithfulness };
    }

    const statistical = bootstrapPairedCI(paired, this.bootstrapIters, this.rng);
    const originalScore = mean(paired.map((p) => (p.originalPassed ? 1 : 0)));
    const mutatedScore = mean(paired.map((p) => (p.mutatedPassed ? 1 : 0)));
    const accepted = statistical.ci95Low > 0;

    const reason = accepted
      ? `paired bootstrap: delta=${(statistical.delta * 100).toFixed(1)}%, ` +
        `ci95=[${(statistical.ci95Low * 100).toFixed(1)}%, ${(statistical.ci95High * 100).toFixed(1)}%] over ${paired.length} held-out trials`
      : `paired bootstrap: ci95 includes zero ` +
        `[${(statistical.ci95Low * 100).toFixed(1)}%, ${(statistical.ci95High * 100).toFixed(1)}%] — insufficient evidence`;

    // Confidence: scales with sample size (saturating at 12 trials) and with
    // the width of the CI being safely away from zero on the accept side.
    const sampleConfidence = Math.min(1, paired.length / MAX_PERFORMANCE_TRIALS);
    const separation = clamp(Math.abs(statistical.ci95Low) / 0.3, 0, 1);
    const confidence = clamp(sampleConfidence * (0.5 + 0.5 * separation));

    return {
      accepted,
      confidence,
      delta: statistical.delta,
      testCasesRun: paired.length,
      originalScore,
      mutatedScore,
      reason,
      mode: "v2-strict",
      faithfulness,
      statistical,
    };
  }

  /**
   * Score one pair of skill texts against a fixed selection set, producing
   * per-task paired pass/fail. The PLAN-21 Phase D longitudinal slow update
   * uses this to compare current SKILL.md against archived prior versions.
   * Returns the empty array when the LLM judge response is unparseable or
   * the selection set is empty.
   *
   * The `textA` / `textB` labels map to the prompt's "ORIGINAL" / "MUTATED"
   * slots respectively; callers driving the slow update pass the prior
   * version as `textA` and the current version as `textB`.
   */
  async scoreVersionPair(
    textA: string,
    textB: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): Promise<ReadonlyArray<{ taskId: string; aPassed: boolean; bPassed: boolean }>> {
    if (selectionSet.length === 0) {
      return [];
    }
    let paired: ReadonlyArray<PairedOutcome>;
    try {
      paired = await this.runPerformanceGate(textA, textB, selectionSet);
    } catch (err) {
      log.debug(`scoreVersionPair runPerformanceGate failed: ${String(err)}`);
      return [];
    }
    return paired.map((p) => ({
      taskId: p.executionId,
      aPassed: p.originalPassed,
      bPassed: p.mutatedPassed,
    }));
  }

  // ── Faithfulness gate ─────────────────────────────────────────────────────

  private async runFaithfulnessGate(
    originalText: string,
    mutatedText: string,
  ): Promise<FaithfulnessResult> {
    // Shortcut: if the mutation is a pure superset of the original (rare but
    // happens during compositional or parametric strategies), no concept can
    // be lost. Saves an LLM call.
    if (mutatedText.length >= originalText.length && mutatedText.includes(originalText)) {
      return { passed: true, missing: [], examined: [] };
    }

    const prompt = this.buildFaithfulnessPrompt(originalText, mutatedText);
    const raw = await this.llmCall(prompt);
    const parsed = parseFaithfulnessResponse(raw);
    if (!parsed) {
      // The judge couldn't be parsed — be strict, treat as failure of the gate
      // but log so the caller can downgrade rather than reject silently.
      log.debug("faithfulness judge returned unparseable response");
      return { passed: false, missing: ["__unparseable__"], examined: [] };
    }
    const missing = parsed.concepts.filter((c) => !c.preserved).map((c) => c.concept);
    const examined = parsed.concepts.map((c) => c.concept);
    return {
      passed: missing.length === 0,
      missing,
      examined,
    };
  }

  private buildFaithfulnessPrompt(originalText: string, mutatedText: string): string {
    return (
      `You are auditing whether a MUTATED skill preserves the key operational concepts ` +
      `of the ORIGINAL. Extract 3-5 key operational concepts from the ORIGINAL skill (the ` +
      `rules and behaviors it commits the agent to). For each concept, mark whether the ` +
      `MUTATED text preserves that concept literally or semantically.\n\n` +
      `ORIGINAL:\n${originalText.slice(0, 1200)}\n\n` +
      `MUTATED:\n${mutatedText.slice(0, 1200)}\n\n` +
      `Respond with a JSON object:\n` +
      `{\n` +
      `  "concepts": [\n` +
      `    { "concept": "short noun phrase", "preserved": true/false }\n` +
      `  ]\n` +
      `}\n\n` +
      `Respond ONLY with the JSON object.`
    );
  }

  // ── Performance gate ──────────────────────────────────────────────────────

  private async runPerformanceGate(
    originalText: string,
    mutatedText: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): Promise<ReadonlyArray<PairedOutcome>> {
    const prompt = this.buildPerformancePrompt(originalText, mutatedText, selectionSet);
    const raw = await this.llmCall(prompt);
    const parsed = parsePerformanceResponse(raw);
    if (!parsed) {
      return [];
    }

    // Pair the judge's per-trial scores back to the selection set rows by
    // 1-based index. Ignore any rows the judge skipped.
    const paired: PairedOutcome[] = [];
    for (const trial of parsed.trials) {
      const idx = trial.index - 1;
      const source = selectionSet[idx];
      if (!source) {
        continue;
      }
      paired.push({
        executionId: source.id,
        originalPassed: trial.originalPassed,
        mutatedPassed: trial.mutatedPassed,
      });
    }
    return paired;
  }

  private buildPerformancePrompt(
    originalText: string,
    mutatedText: string,
    selectionSet: ReadonlyArray<HeldOutExecution>,
  ): string {
    const trialsBlock = selectionSet
      .map((exec, i) => {
        const context = (exec.contextJson ?? "{}").slice(0, MAX_CONTEXT_CHARS);
        const errorTag = exec.errorType ? ` (original error_type=${exec.errorType})` : "";
        return `[${i + 1}] originalSucceeded=${exec.success}${errorTag}\n    context: ${context}`;
      })
      .join("\n");

    return (
      `You are scoring whether each version of a skill would have produced a successful ` +
      `outcome given a past execution context. The ORIGINAL skill actually ran on each ` +
      `context; we want to know if the MUTATED version would have done at least as well.\n\n` +
      `ORIGINAL SKILL:\n${originalText.slice(0, 1000)}\n\n` +
      `MUTATED SKILL:\n${mutatedText.slice(0, 1000)}\n\n` +
      `Past execution contexts:\n${trialsBlock}\n\n` +
      `Respond with a JSON object:\n` +
      `{\n` +
      `  "trials": [\n` +
      `    { "index": 1, "originalPassed": true/false, "mutatedPassed": true/false }\n` +
      `  ]\n` +
      `}\n\n` +
      `Include one entry per past context. Respond ONLY with the JSON object.`
    );
  }

  // ── Legacy synthetic-scenario path (cold start fallback) ─────────────────

  private async legacyEvaluate(
    skill: {
      id: string;
      text: string;
      skill_category: string | null;
      importance_score: number;
    },
    mutatedText: string,
    mode: SandboxMode,
  ): Promise<MutationVerdict> {
    try {
      const baseline = this.getBaselineData(skill.id);
      const originalScore = 0.6 * baseline.successRate + 0.4 * baseline.avgReward;
      const prompt = this.buildLegacyEvaluationPrompt(skill, mutatedText, baseline);
      const raw = await this.llmCall(prompt);
      const parsed = parseLegacyEvaluationResponse(raw);
      if (!parsed) {
        return this.negativeVerdict(originalScore, "LLM response could not be parsed", mode);
      }

      const scenarioAvg =
        parsed.testScenarios.length > 0
          ? parsed.testScenarios.reduce((s, sc) => s + sc.mutatedScore, 0) /
            parsed.testScenarios.length
          : parsed.overallMutatedScore;
      const criteriaValues = Object.values(parsed.criteriaScores);
      const criteriaAvg =
        criteriaValues.length > 0
          ? criteriaValues.reduce((a, b) => a + b, 0) / criteriaValues.length
          : parsed.overallMutatedScore;
      const mutatedScore = clamp(
        0.4 * scenarioAvg + 0.3 * criteriaAvg + 0.3 * parsed.overallMutatedScore,
      );
      const testCasesRun = Math.max(1, parsed.testScenarios.length);
      const delta = mutatedScore - originalScore;
      const accepted = delta > ACCEPTANCE_THRESHOLD;
      const dataSufficiency = Math.min(1, testCasesRun / 5);
      const scoreClarity = Math.min(1, Math.abs(delta) / 0.3);
      const confidence = clamp(dataSufficiency * (0.5 + 0.5 * scoreClarity));
      const reason = accepted
        ? `mutation improves skill by ${(delta * 100).toFixed(1)}%: ${parsed.reasoning}`
        : delta <= ACCEPTANCE_THRESHOLD
          ? `insufficient improvement (${(delta * 100).toFixed(1)}% < ${ACCEPTANCE_THRESHOLD * 100}% threshold)`
          : `mutation degrades performance by ${(Math.abs(delta) * 100).toFixed(1)}%`;

      return {
        accepted,
        confidence,
        delta,
        testCasesRun,
        originalScore,
        mutatedScore,
        reason,
        mode,
      };
    } catch (err) {
      log.debug(`legacyEvaluate failed: ${String(err)}`);
      return this.negativeVerdict(0, `evaluation failed: ${String(err)}`, mode);
    }
  }

  private getBaselineData(skillId: string): {
    successRate: number;
    avgReward: number;
    totalExecutions: number;
    errorTypes: string[];
  } {
    try {
      const rows = this.db
        .prepare(
          `SELECT success, reward_score, error_type
           FROM skill_executions
           WHERE skill_crystal_id = ? AND completed_at IS NOT NULL
           ORDER BY started_at DESC
           LIMIT 20`,
        )
        .all(skillId) as Array<{
        success: number | null;
        reward_score: number | null;
        error_type: string | null;
      }>;

      if (rows.length === 0) {
        return { successRate: 0.5, avgReward: 0.5, totalExecutions: 0, errorTypes: [] };
      }

      let successes = 0;
      let rewardTotal = 0;
      let rewardCount = 0;
      const errorTypes = new Set<string>();
      for (const row of rows) {
        if (row.success === 1) {
          successes++;
        }
        if (row.reward_score != null) {
          rewardTotal += row.reward_score;
          rewardCount++;
        }
        if (row.error_type) {
          errorTypes.add(row.error_type);
        }
      }
      return {
        successRate: successes / rows.length,
        avgReward: rewardCount > 0 ? rewardTotal / rewardCount : 0.5,
        totalExecutions: rows.length,
        errorTypes: [...errorTypes],
      };
    } catch {
      return { successRate: 0.5, avgReward: 0.5, totalExecutions: 0, errorTypes: [] };
    }
  }

  private buildLegacyEvaluationPrompt(
    skill: { text: string; skill_category: string | null },
    mutatedText: string,
    baseline: {
      successRate: number;
      totalExecutions: number;
      errorTypes: string[];
    },
  ): string {
    const category = skill.skill_category ?? "general";
    const errorSummary =
      baseline.errorTypes.length > 0 ? baseline.errorTypes.join(", ") : "none recorded";
    return (
      `You are evaluating a proposed mutation to a skill/pattern.\n\n` +
      `ORIGINAL SKILL:\n${skill.text.slice(0, 1000)}\n\n` +
      `PROPOSED MUTATION:\n${mutatedText.slice(0, 1000)}\n\n` +
      `Category: ${category}\n` +
      `Baseline: ${(baseline.successRate * 100).toFixed(0)}% success rate over ${baseline.totalExecutions} executions\n` +
      `Known error types: ${errorSummary}\n\n` +
      `EVALUATION CRITERIA:\n` +
      `1. edgeCases: Does the mutation handle edge cases better? (0-1)\n` +
      `2. clarity: Is the mutation clearer and more robust? (0-1)\n` +
      `3. intentPreservation: Does the mutation preserve the core intent? (0-1)\n` +
      `4. improvement: Would the mutation likely improve success rate? (0-1)\n\n` +
      `Generate 3-5 synthetic test scenarios relevant to this skill category, ` +
      `and score how each version (original vs mutated) would perform.\n\n` +
      `Respond with a JSON object:\n` +
      `{\n` +
      `  "criteriaScores": { "edgeCases": 0.0, "clarity": 0.0, "intentPreservation": 0.0, "improvement": 0.0 },\n` +
      `  "testScenarios": [\n` +
      `    { "scenario": "description", "originalScore": 0.0, "mutatedScore": 0.0 }\n` +
      `  ],\n` +
      `  "overallMutatedScore": 0.0,\n` +
      `  "reasoning": "brief explanation"\n` +
      `}\n\n` +
      `Respond ONLY with the JSON object.`
    );
  }

  private negativeVerdict(
    originalScore: number,
    reason: string,
    mode: SandboxMode,
  ): MutationVerdict {
    return {
      accepted: false,
      confidence: 0,
      delta: 0,
      testCasesRun: 1,
      originalScore,
      mutatedScore: originalScore,
      reason,
      mode,
    };
  }
}

// ── Parsing helpers ─────────────────────────────────────────────────────────

interface PairedOutcome {
  executionId: string;
  originalPassed: boolean;
  mutatedPassed: boolean;
}

interface ParsedFaithfulness {
  concepts: Array<{ concept: string; preserved: boolean }>;
}

interface ParsedPerformance {
  trials: Array<{ index: number; originalPassed: boolean; mutatedPassed: boolean }>;
}

interface ParsedLegacyEvaluation {
  criteriaScores: Record<string, number>;
  testScenarios: Array<{ scenario: string; originalScore: number; mutatedScore: number }>;
  overallMutatedScore: number;
  reasoning: string;
}

function stripFences(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return cleaned;
}

function parseFaithfulnessResponse(raw: string): ParsedFaithfulness | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const conceptsRaw = (parsed as { concepts?: unknown }).concepts;
    if (!Array.isArray(conceptsRaw)) {
      return null;
    }
    const concepts: Array<{ concept: string; preserved: boolean }> = [];
    for (const entry of conceptsRaw) {
      if (entry && typeof entry === "object") {
        const conceptRaw = (entry as { concept?: unknown }).concept;
        const concept = typeof conceptRaw === "string" ? conceptRaw.trim() : "";
        const preserved = Boolean((entry as { preserved?: unknown }).preserved);
        if (concept) {
          concepts.push({ concept, preserved });
        }
      }
    }
    if (concepts.length === 0) {
      return null;
    }
    return { concepts };
  } catch {
    return null;
  }
}

function parsePerformanceResponse(raw: string): ParsedPerformance | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const trialsRaw = (parsed as { trials?: unknown }).trials;
    if (!Array.isArray(trialsRaw)) {
      return null;
    }
    const trials: Array<{ index: number; originalPassed: boolean; mutatedPassed: boolean }> = [];
    for (const entry of trialsRaw) {
      if (entry && typeof entry === "object") {
        const index = Number((entry as { index?: unknown }).index);
        const originalPassed = Boolean((entry as { originalPassed?: unknown }).originalPassed);
        const mutatedPassed = Boolean((entry as { mutatedPassed?: unknown }).mutatedPassed);
        if (Number.isFinite(index) && index >= 1) {
          trials.push({ index, originalPassed, mutatedPassed });
        }
      }
    }
    if (trials.length === 0) {
      return null;
    }
    return { trials };
  } catch {
    return null;
  }
}

function parseLegacyEvaluationResponse(raw: string): ParsedLegacyEvaluation | null {
  try {
    const parsed = JSON.parse(stripFences(raw)) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const criteriaScores: Record<string, number> = {};
    if (obj.criteriaScores && typeof obj.criteriaScores === "object") {
      for (const [key, val] of Object.entries(obj.criteriaScores as Record<string, unknown>)) {
        if (typeof val === "number") {
          criteriaScores[key] = clamp(val);
        }
      }
    }
    const testScenarios: Array<{ scenario: string; originalScore: number; mutatedScore: number }> =
      [];
    if (Array.isArray(obj.testScenarios)) {
      for (const s of obj.testScenarios) {
        if (
          s &&
          typeof s === "object" &&
          typeof (s as { scenario?: unknown }).scenario === "string"
        ) {
          const rec = s as { scenario: string; originalScore?: unknown; mutatedScore?: unknown };
          testScenarios.push({
            scenario: rec.scenario,
            originalScore: clamp(Number(rec.originalScore) || 0),
            mutatedScore: clamp(Number(rec.mutatedScore) || 0),
          });
        }
      }
    }
    const overallMutatedScore = clamp(Number(obj.overallMutatedScore) || 0);
    const reasoning =
      typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 500) : "no reasoning provided";
    return { criteriaScores, testScenarios, overallMutatedScore, reasoning };
  } catch {
    return null;
  }
}

// ── Bootstrap CI ────────────────────────────────────────────────────────────

/**
 * Paired bootstrap on per-trial deltas. Returns the mean delta and the 95%
 * percentile CI. Pure given a seeded RNG, so tests can pin determinism.
 */
export function bootstrapPairedCI(
  paired: ReadonlyArray<PairedOutcome>,
  iterations: number = BOOTSTRAP_ITERATIONS,
  random: () => number = Math.random,
): StatisticalResult {
  const n = paired.length;
  if (n === 0) {
    return { delta: 0, ci95Low: 0, ci95High: 0, nPaired: 0 };
  }
  const deltas = paired.map((p) => (p.mutatedPassed ? 1 : 0) - (p.originalPassed ? 1 : 0));
  const observed = mean(deltas);
  const resampleMeans: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.min(n - 1, Math.floor(random() * n));
      sum += deltas[idx]!;
    }
    resampleMeans.push(sum / n);
  }
  resampleMeans.sort((a, b) => a - b);
  const lowIdx = Math.floor(0.025 * iterations);
  const highIdx = Math.min(iterations - 1, Math.floor(0.975 * iterations));
  return {
    delta: observed,
    ci95Low: resampleMeans[lowIdx] ?? observed,
    ci95High: resampleMeans[highIdx] ?? observed,
    nPaired: n,
  };
}

// ── Misc ───────────────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

function mean(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  let s = 0;
  for (const v of values) {
    s += v;
  }
  return s / values.length;
}

export const __testing = {
  bootstrapPairedCI,
  parseFaithfulnessResponse,
  parsePerformanceResponse,
  parseLegacyEvaluationResponse,
};
