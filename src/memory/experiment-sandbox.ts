/**
 * ExperimentSandbox: A/B evaluation of skill mutations for the dream engine's
 * research mode (Karpathy autoresearch pattern).
 *
 * Compares an original skill against a proposed mutation by:
 *   1. Computing a baseline score from real execution history
 *   2. Asking an LLM to generate synthetic test scenarios
 *   3. Scoring both versions against those scenarios
 *   4. Returning a MutationVerdict: promote (git advance) or archive (git reset)
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/experiment-sandbox");

export interface MutationVerdict {
  /** Whether the mutation outperforms the original by the acceptance threshold. */
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
}

/** Minimum improvement delta required for acceptance. */
const ACCEPTANCE_THRESHOLD = 0.05;

export class ExperimentSandbox {
  constructor(
    private readonly db: DatabaseSync,
    private readonly llmCall: (prompt: string) => Promise<string>,
  ) {}

  /**
   * Evaluate a proposed skill mutation against the original.
   * Returns a MutationVerdict indicating whether the mutation should be promoted.
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
    try {
      // 1. Get baseline execution data
      const baseline = this.getBaselineData(skill.id);
      const originalScore = 0.6 * baseline.successRate + 0.4 * baseline.avgReward;

      // 2. Build evaluation prompt
      const prompt = this.buildEvaluationPrompt(skill, mutatedText, baseline);

      // 3. Call LLM for evaluation
      const raw = await this.llmCall(prompt);

      // 4. Parse response
      const parsed = this.parseEvaluationResponse(raw);
      if (!parsed) {
        return this.negativeVerdict(originalScore, "LLM response could not be parsed");
      }

      // 5. Calculate mutated score from blended LLM assessment
      const scenarioAvg =
        parsed.testScenarios.length > 0
          ? parsed.testScenarios.reduce((sum, s) => sum + s.mutatedScore, 0) /
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

      // 6. Calculate confidence
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
      };
    } catch (err) {
      log.debug(`evaluate failed: ${String(err)}`);
      return this.negativeVerdict(0, `evaluation failed: ${String(err)}`);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

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
        if (row.success === 1) successes++;
        if (row.reward_score != null) {
          rewardTotal += row.reward_score;
          rewardCount++;
        }
        if (row.error_type) errorTypes.add(row.error_type);
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

  private buildEvaluationPrompt(
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

  private parseEvaluationResponse(raw: string): {
    criteriaScores: Record<string, number>;
    testScenarios: Array<{
      scenario: string;
      originalScore: number;
      mutatedScore: number;
    }>;
    overallMutatedScore: number;
    reasoning: string;
  } | null {
    try {
      // Strip markdown code fences
      let cleaned = raw.trim();
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object") return null;

      // Validate and extract criteriaScores
      const criteriaScores: Record<string, number> = {};
      if (parsed.criteriaScores && typeof parsed.criteriaScores === "object") {
        for (const [key, val] of Object.entries(parsed.criteriaScores)) {
          if (typeof val === "number") {
            criteriaScores[key] = clamp(val);
          }
        }
      }

      // Validate and extract testScenarios
      const testScenarios: Array<{
        scenario: string;
        originalScore: number;
        mutatedScore: number;
      }> = [];
      if (Array.isArray(parsed.testScenarios)) {
        for (const s of parsed.testScenarios) {
          if (s && typeof s === "object" && typeof s.scenario === "string") {
            testScenarios.push({
              scenario: String(s.scenario),
              originalScore: clamp(Number(s.originalScore) || 0),
              mutatedScore: clamp(Number(s.mutatedScore) || 0),
            });
          }
        }
      }

      const overallMutatedScore = clamp(Number(parsed.overallMutatedScore) || 0);
      const reasoning =
        typeof parsed.reasoning === "string"
          ? parsed.reasoning.slice(0, 500)
          : "no reasoning provided";

      return { criteriaScores, testScenarios, overallMutatedScore, reasoning };
    } catch {
      log.debug("failed to parse evaluation response");
      return null;
    }
  }

  private negativeVerdict(originalScore: number, reason: string): MutationVerdict {
    return {
      accepted: false,
      confidence: 0,
      delta: 0,
      testCasesRun: 1,
      originalScore,
      mutatedScore: originalScore,
      reason,
    };
  }
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}
