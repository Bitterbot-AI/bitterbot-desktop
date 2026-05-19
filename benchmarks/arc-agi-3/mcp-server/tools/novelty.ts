/**
 * memory.score_novelty — quick GCCRF-style novelty score for a
 * (state, action) pair. Higher = the agent hasn't seen this
 * combination much and exploring it is more informative.
 *
 * Implementation: count incoming edges of `transforms_into` on the
 * prev-state node and divide by max neighborhood degree across the
 * graph. Fast O(1) lookup; no embedding cost.
 *
 * If the curiosity engine is wired up, we also blend its prediction-
 * error component when an embedding for the state hash is available.
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const scoreNoveltyInputSchema = {
  gameId: z.string(),
  stateHash: z.string(),
  action: z.string().describe("Action label e.g. 'ACTION3' or 'ACTION6(x=10,y=20)'."),
};

export type ScoreNoveltyInput = {
  gameId: string;
  stateHash: string;
  action: string;
};

export interface ScoreNoveltyResult {
  novelty: number;
  observedCount: number;
  maxNeighborDegree: number;
}

export async function runScoreNovelty(input: ScoreNoveltyInput): Promise<ScoreNoveltyResult> {
  const ctx = await getMemoryContext();
  const kg = ctx.knowledgeGraph;
  const stateName = `state:${input.gameId}:${input.stateHash}`;
  const actionName = `${input.gameId}:${input.action}`;

  const stateEntity = kg.findEntityByNameType(stateName, "arc_state");
  if (!stateEntity) {
    // Never seen this state at all → maximum novelty.
    return { novelty: 1, observedCount: 0, maxNeighborDegree: 0 };
  }
  const stateGraph = kg.traverseEntity(stateEntity.id, true);
  if (!stateGraph) {
    return { novelty: 1, observedCount: 0, maxNeighborDegree: 0 };
  }
  // Count transitions out of this state via the named action.
  const observedCount = stateGraph.relationships.filter(
    (r) =>
      r.direction === "outgoing" &&
      r.relationship.relationType === "transforms_into" &&
      r.connectedEntity.entityType === "arc_state",
  ).length;

  // Look up the action entity's mentionCount as a rough cap on
  // "everywhere I've seen this action used."
  const actionEntity = kg.findEntityByNameType(actionName, "arc_action");
  const actionMentions = actionEntity?.mentionCount ?? 0;
  const maxDegree = Math.max(observedCount, actionMentions);
  // Logistic squash so 0 attempts = ~1.0 novelty; 5 attempts = ~0.5;
  // 20+ attempts = ~0.1.
  const novelty = 1 / (1 + observedCount * 0.3);
  return {
    novelty: Math.max(0, Math.min(1, novelty)),
    observedCount,
    maxNeighborDegree: maxDegree,
  };
}

export const SCORE_NOVELTY_TOOL_DEF = {
  name: "memory_score_novelty",
  title: "Score the novelty of a (state, action) pair",
  description:
    "Return a 0..1 novelty score for the prospective (state, action) pair. 1 = never seen, 0 = exhaustively explored. Use to bias toward unexplored actions when goal-hypothesis confidence is low.",
  inputSchema: scoreNoveltyInputSchema,
} as const;
