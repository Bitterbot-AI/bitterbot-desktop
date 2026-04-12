/**
 * PromptOptimizationExperiment: finds underperforming skills and generates
 * improved mutations for the dream engine's research mode.
 *
 * Part of the Karpathy autoresearch pattern:
 *   findCandidates() → identify skills with room for improvement
 *   optimize()       → generate mutations using strategy-aware LLM prompts
 *
 * The dream engine then A/B tests these mutations via ExperimentSandbox
 * and promotes or archives them based on the MutationVerdict.
 */

import type { DatabaseSync } from "node:sqlite";
import type { SkillMetrics } from "./crystal-types.js";
import type { SkillExecutionTracker } from "./skill-execution-tracker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  selectStrategy,
  buildStrategyPrompt,
  type StrategyContext,
} from "./dream-mutation-strategies.js";

const log = createSubsystemLogger("memory/prompt-optimization");

/** Minimum execution count to consider a skill for optimization. */
const MIN_EXECUTIONS = 3;
/** Skills with success rate below this are too broken to optimize. */
const MIN_SUCCESS_RATE = 0.3;
/** Skills with success rate above this don't need optimization. */
const MAX_SUCCESS_RATE = 0.9;

export interface OptimizationCandidate {
  skill: {
    id: string;
    text: string;
    skill_category: string | null;
    importance_score: number;
  };
  metrics: SkillMetrics;
}

export interface OptimizationResult {
  /** The mutated skill text. */
  content: string;
  /** LLM confidence in this mutation (0–1). */
  confidence: number;
  /** Opportunity score based on how much room for improvement exists (0–1). */
  opportunityScore: number;
  /** The mutation strategy that was used. */
  strategy?: string | null;
}

export class PromptOptimizationExperiment {
  constructor(
    private readonly db: DatabaseSync,
    private readonly executionTracker: SkillExecutionTracker,
  ) {}

  /**
   * Find skills that are good candidates for optimization:
   * have enough execution data, and a success rate that suggests room for improvement.
   */
  findCandidates(maxChunks: number): OptimizationCandidate[] {
    try {
      // Query skill-type chunks with execution history potential
      const rows = this.db
        .prepare(
          `SELECT id, text, skill_category, importance_score, last_dreamed_at
           FROM chunks
           WHERE (COALESCE(lifecycle, 'generated') IN ('generated', 'activated', 'frozen')
                  OR (lifecycle IS NULL AND COALESCE(lifecycle_state, 'active') = 'active'))
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
           ORDER BY importance_score DESC
           LIMIT ?`,
        )
        .all(maxChunks * 5) as Array<{
        id: string;
        text: string;
        skill_category: string | null;
        importance_score: number;
        last_dreamed_at: number | null;
      }>;

      const candidates: Array<{
        candidate: OptimizationCandidate;
        opportunityScore: number;
        lastDreamedAt: number | null;
      }> = [];

      for (const row of rows) {
        const metrics = this.executionTracker.getSkillMetrics(row.id);

        // Must have enough executions for meaningful data
        if (metrics.totalExecutions < MIN_EXECUTIONS) {
          continue;
        }
        // Must have room for improvement (not too broken, not too good)
        if (metrics.successRate < MIN_SUCCESS_RATE) {
          continue;
        }
        if (metrics.successRate > MAX_SUCCESS_RATE) {
          continue;
        }

        const opportunityScore = (1 - metrics.successRate) * row.importance_score;

        candidates.push({
          candidate: {
            skill: {
              id: row.id,
              text: row.text,
              skill_category: row.skill_category,
              importance_score: row.importance_score,
            },
            metrics,
          },
          opportunityScore,
          lastDreamedAt: row.last_dreamed_at,
        });
      }

      // Sort by opportunity (highest first), then prefer un-dreamed skills
      candidates.sort((a, b) => {
        const scoreDiff = b.opportunityScore - a.opportunityScore;
        if (Math.abs(scoreDiff) > 0.01) {
          return scoreDiff;
        }
        // Prefer skills that haven't been dreamed recently
        const aAge = a.lastDreamedAt ?? 0;
        const bAge = b.lastDreamedAt ?? 0;
        return aAge - bAge; // older dreamed_at = higher priority
      });

      const result = candidates.slice(0, maxChunks).map((c) => c.candidate);

      if (result.length > 0) {
        log.debug(
          `found ${result.length} optimization candidates (from ${rows.length} skills scanned)`,
        );
      }

      return result;
    } catch (err) {
      log.debug(`findCandidates failed: ${String(err)}`);
      return [];
    }
  }

  /**
   * Generate mutation proposals for a candidate skill using strategy-aware
   * LLM prompts. Returns parsed mutations with confidence scores.
   */
  async optimize(
    candidate: OptimizationCandidate,
    llmCall: (prompt: string) => Promise<string>,
  ): Promise<OptimizationResult[]> {
    try {
      const { skill, metrics } = candidate;

      // Count related skills for compositional strategy selection
      const relatedCount = this.countRelatedSkills(skill.id, skill.skill_category);

      // Select the best mutation strategy based on metrics
      const strategy = selectStrategy(
        { text: skill.text, skillCategory: skill.skill_category },
        metrics,
        relatedCount,
      );

      // Build strategy-specific context
      const context: StrategyContext = { metrics };
      if (strategy === "compositional" && relatedCount > 0) {
        context.relatedSkills = this.getRelatedSkills(skill.id, skill.skill_category, 2);
      }

      // Build and send the mutation prompt
      const prompt = buildStrategyPrompt(strategy, skill.text, context);
      const raw = await llmCall(prompt);

      // Parse the LLM response
      const parsed = this.parseMutationResponse(raw);
      if (parsed.length === 0) {
        log.debug("optimize: no mutations parsed from LLM response");
        return [];
      }

      // Calculate opportunity score (same for all mutations from this candidate)
      const opportunityScore = Math.min(1, (1 - metrics.successRate) * skill.importance_score);

      return parsed.map((item) => ({
        content: item.content,
        confidence: clamp(item.confidence),
        opportunityScore,
        strategy,
      }));
    } catch (err) {
      log.debug(`optimize failed: ${String(err)}`);
      return [];
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private countRelatedSkills(skillId: string, category: string | null): number {
    if (!category) {
      return 0;
    }
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as c FROM chunks
           WHERE id != ?
             AND skill_category = ?
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')`,
        )
        .get(skillId, category) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  private getRelatedSkills(
    skillId: string,
    category: string | null,
    limit: number,
  ): Array<{ text: string; id: string }> {
    if (!category) {
      return [];
    }
    try {
      return this.db
        .prepare(
          `SELECT id, text FROM chunks
           WHERE id != ?
             AND skill_category = ?
             AND (COALESCE(memory_type, 'plaintext') = 'skill'
                  OR COALESCE(semantic_type, 'general') = 'skill')
           ORDER BY importance_score DESC
           LIMIT ?`,
        )
        .all(skillId, category, limit) as Array<{
        id: string;
        text: string;
      }>;
    } catch {
      return [];
    }
  }

  /**
   * Parse an LLM response into mutation results.
   * Expects a JSON array of { content, confidence, keywords }.
   * Handles markdown code fences and noisy output gracefully.
   */
  private parseMutationResponse(raw: string): Array<{ content: string; confidence: number }> {
    try {
      let cleaned = raw.trim();
      // Strip markdown code fences
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) {
        return [];
      }

      const results: Array<{ content: string; confidence: number }> = [];
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof item.content === "string" &&
          item.content.length > 0
        ) {
          results.push({
            content: item.content.slice(0, 2000),
            confidence: clamp(Number(item.confidence) || 0.5),
          });
        }
      }
      return results;
    } catch {
      log.debug("failed to parse mutation response as JSON");
      return [];
    }
  }
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}
