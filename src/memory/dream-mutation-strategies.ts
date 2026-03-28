/**
 * Dream Mutation Strategies: strategy-based mutation selection and
 * strategy-specific LLM prompts for the advanced dream mutation engine.
 */

import type { KnowledgeCrystal, MutationStrategy, SkillMetrics } from "./crystal-types.js";

/**
 * Select the best mutation strategy for a skill based on its execution metrics
 * and properties.
 */
export function selectStrategy(
  skill: { text: string; skillCategory?: string | null },
  metrics: SkillMetrics | null,
  relatedSkillCount?: number,
): MutationStrategy {
  if (metrics && metrics.totalExecutions >= 3) {
    // High error rate → fix the errors
    const topErrorCount = Object.values(metrics.errorBreakdown).reduce((a, b) => a + b, 0);
    if (topErrorCount >= 2) return "error_driven";

    // High success rate → find edge cases
    if (metrics.successRate > 0.9) return "adversarial";
  }

  // Multiple related skills in the same category → combine them
  if (relatedSkillCount != null && relatedSkillCount >= 2) return "compositional";

  // Has numeric parameters → try tuning them
  if (hasNumericParameters(skill.text)) return "parametric";

  return "generic";
}

/**
 * Build a mutation prompt specific to the chosen strategy.
 */
export function buildStrategyPrompt(
  strategy: MutationStrategy,
  skillText: string,
  context: StrategyContext,
): string {
  switch (strategy) {
    case "error_driven":
      return buildErrorDrivenPrompt(skillText, context);
    case "adversarial":
      return buildAdversarialPrompt(skillText);
    case "compositional":
      return buildCompositionalPrompt(skillText, context);
    case "parametric":
      return buildParametricPrompt(skillText);
    default:
      return buildGenericPrompt(skillText);
  }
}

export type StrategyContext = {
  metrics?: SkillMetrics | null;
  relatedSkills?: Array<{ text: string; id: string }>;
};

function buildGenericPrompt(skillText: string): string {
  return (
    `You are a Dream Engine generating skill mutations. Given this skill/pattern, ` +
    `generate 3 improved variations that might be more effective. Vary the approach, ` +
    `parameters, or strategy while preserving the core intent.\n\n` +
    `Original skill:\n${skillText.slice(0, 1500)}\n\n` +
    `Respond with a JSON array of objects, each with:\n` +
    `- "content": the mutated skill description (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating how useful this mutation is\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array.`
  );
}

function buildErrorDrivenPrompt(skillText: string, context: StrategyContext): string {
  const errors = context.metrics?.errorBreakdown ?? {};
  const topErrors = Object.entries(errors)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  const errorSummary = topErrors.length > 0
    ? topErrors.map(([type, count]) => `- ${type}: ${count} occurrences`).join("\n")
    : "- Various execution failures";

  return (
    `You are a Dream Engine fixing skill failures. This skill has been executing ` +
    `but encountering errors. Analyze the failure patterns and generate 3 mutations ` +
    `that specifically address these failure modes.\n\n` +
    `Original skill:\n${skillText.slice(0, 1200)}\n\n` +
    `Known failure patterns:\n${errorSummary}\n\n` +
    `Success rate: ${((context.metrics?.successRate ?? 0) * 100).toFixed(0)}%\n\n` +
    `Generate mutations that handle these specific failure modes. ` +
    `Respond with a JSON array of objects, each with:\n` +
    `- "content": the improved skill handling the failure (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating how likely this fixes the error\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array.`
  );
}

function buildAdversarialPrompt(skillText: string): string {
  return (
    `You are a Dream Engine hardening a high-performing skill. This skill already works ` +
    `well (>90% success rate). Your job is to find edge cases where it might fail and ` +
    `generate hardened versions.\n\n` +
    `Original skill:\n${skillText.slice(0, 1200)}\n\n` +
    `1. Identify 3 edge cases where this skill could fail\n` +
    `2. For each, generate a mutation that handles that edge case\n\n` +
    `Respond with a JSON array of objects, each with:\n` +
    `- "content": the hardened skill version (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating edge case severity\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array.`
  );
}

function buildCompositionalPrompt(skillText: string, context: StrategyContext): string {
  const related = context.relatedSkills ?? [];
  const relatedTexts = related
    .slice(0, 2)
    .map((s, i) => `Related skill ${i + 1}:\n${s.text.slice(0, 500)}`)
    .join("\n\n");

  return (
    `You are a Dream Engine composing skills. Combine the best aspects of these ` +
    `related skills into a unified, more capable skill.\n\n` +
    `Primary skill:\n${skillText.slice(0, 800)}\n\n` +
    `${relatedTexts}\n\n` +
    `Generate 3 composite skills that unify the best aspects. ` +
    `Respond with a JSON array of objects, each with:\n` +
    `- "content": the composite skill (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating how well the composition works\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array.`
  );
}

function buildParametricPrompt(skillText: string): string {
  return (
    `You are a Dream Engine tuning skill parameters. This skill contains numeric ` +
    `parameters (thresholds, timeouts, counts, etc.). Suggest alternative parameter ` +
    `ranges that might improve performance.\n\n` +
    `Original skill:\n${skillText.slice(0, 1200)}\n\n` +
    `Identify numeric parameters and generate 3 variations with different settings. ` +
    `Respond with a JSON array of objects, each with:\n` +
    `- "content": the skill with adjusted parameters (1-3 sentences)\n` +
    `- "confidence": float 0-1 indicating expected improvement\n` +
    `- "keywords": array of 2-5 relevant keywords\n\n` +
    `Respond ONLY with the JSON array.`
  );
}

function hasNumericParameters(text: string): boolean {
  // Look for patterns like: timeout=30, max_retries: 3, threshold 0.8
  return /\b\d+(?:\.\d+)?\s*(?:ms|seconds?|retries|attempts|timeout|threshold|limit|max|min)\b/i.test(text)
    || /\b(?:timeout|retries|attempts|threshold|limit|max|min)\s*[=:]\s*\d/i.test(text);
}
