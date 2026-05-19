/**
 * memory.record_rule — write a learned game-rule into the knowledge
 * graph as an `arc_rule` entity. Use after observing a confirmed
 * (state-pattern → action → outcome) transition.
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const recordRuleInputSchema = {
  rule: z
    .string()
    .min(4)
    .describe(
      "Natural-language statement of the learned rule (e.g., 'ACTION3 moves blue cells one row down').",
    ),
  gameId: z.string().describe("Game ID the rule was learned in."),
  evidence: z
    .array(z.string())
    .optional()
    .describe("Optional list of frame paths or state hashes that evidence the rule."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Confidence in the rule, 0..1. Default 0.7."),
};

export type RecordRuleInput = {
  rule: string;
  gameId: string;
  evidence?: string[];
  confidence?: number;
};

export interface RecordRuleResult {
  ruleId: string;
  reinforced: boolean;
  totalRulesForGame: number;
}

export async function runRecordRule(input: RecordRuleInput): Promise<RecordRuleResult> {
  const ctx = await getMemoryContext();
  const kg = ctx.knowledgeGraph;

  // The rule itself becomes an entity. The game it belongs to is a
  // sibling entity related to it via `observed_in`.
  const ruleName = `rule:${input.gameId}:${shortHash(input.rule)}`;
  const rule = kg.upsertEntity({
    name: ruleName,
    type: "arc_rule",
    properties: {
      text: input.rule,
      gameId: input.gameId,
      confidence: input.confidence ?? 0.7,
      evidenceCount: input.evidence?.length ?? 0,
      lastEvidence: input.evidence?.slice(-5) ?? [],
    },
  });
  const game = kg.upsertEntity({ name: input.gameId, type: "concept" });
  const reinforced = rule.mentionCount > 1;
  kg.upsertRelationship({
    sourceName: rule.name,
    sourceType: "arc_rule",
    targetName: game.name,
    targetType: "concept",
    relationType: "observed_in",
    weight: input.confidence ?? 0.7,
  });

  // Count rules so far for this game.
  const allRules = kg.searchEntities(`rule:${input.gameId}:`, 200);
  return {
    ruleId: rule.id,
    reinforced,
    totalRulesForGame: allRules.filter((e) => e.entityType === "arc_rule").length,
  };
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return ((h >>> 0).toString(36) + "00000").slice(0, 8);
}

export const RECORD_RULE_TOOL_DEF = {
  name: "memory_record_rule",
  title: "Record a learned game rule",
  description:
    "Persist a natural-language rule into the knowledge graph as an arc_rule entity. Use after you observe a confirmed (state pattern → action → outcome) transition. Repeated calls with the same rule string reinforce confidence.",
  inputSchema: recordRuleInputSchema,
} as const;
