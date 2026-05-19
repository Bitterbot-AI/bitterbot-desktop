/**
 * memory.list_rules — enumerate the arc_rule entities for a game.
 * Used at level-start so the agent can refresh its working set of
 * confirmed transition rules without doing a free-text SAGE query.
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const listRulesInputSchema = {
  gameId: z.string(),
  limit: z.number().int().positive().max(100).optional(),
};

export type ListRulesInput = { gameId: string; limit?: number };

export interface ArcRuleSummary {
  ruleId: string;
  text: string;
  confidence: number;
  evidenceCount: number;
  mentionCount: number;
}

export async function runListRules(input: ListRulesInput): Promise<{ rules: ArcRuleSummary[] }> {
  const ctx = await getMemoryContext();
  const limit = input.limit ?? 20;
  const candidates = ctx.knowledgeGraph
    .searchEntities(`rule:${input.gameId}:`, limit * 2)
    .filter((e) => e.entityType === "arc_rule")
    .slice(0, limit);
  return {
    rules: candidates.map((e) => ({
      ruleId: e.id,
      text: String(e.properties.text ?? ""),
      confidence: Number(e.properties.confidence ?? 0.5),
      evidenceCount: Number(e.properties.evidenceCount ?? 0),
      mentionCount: e.mentionCount,
    })),
  };
}

export const LIST_RULES_TOOL_DEF = {
  name: "memory_list_rules",
  title: "List learned rules for a game",
  description:
    "Return all arc_rule entities recorded for the given game, with their natural-language text, confidence, and evidence counts. Call this at the start of each new level to refresh your working set.",
  inputSchema: listRulesInputSchema,
} as const;
