/**
 * memory.log_transition — record one (prev_state, action, next_state)
 * tuple as graph entities + relationship. Used by the agent or the
 * transition harvester after every action.
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const logTransitionInputSchema = {
  gameId: z.string(),
  prevStateHash: z.string().min(1),
  action: z.string().describe("Action label, e.g., 'ACTION1' or 'ACTION6(x=10,y=20)' or 'RESET'."),
  nextStateHash: z.string().min(1),
  pixelDelta: z.number().int().optional(),
  levelsCompleted: z.number().int().optional(),
};

export type LogTransitionInput = {
  gameId: string;
  prevStateHash: string;
  action: string;
  nextStateHash: string;
  pixelDelta?: number;
  levelsCompleted?: number;
};

export interface LogTransitionResult {
  transitionId: string;
  edgeReinforced: boolean;
  graphSize: { entities: number; relationships: number };
}

export async function runLogTransition(input: LogTransitionInput): Promise<LogTransitionResult> {
  const ctx = await getMemoryContext();
  const kg = ctx.knowledgeGraph;

  const prevName = `state:${input.gameId}:${input.prevStateHash}`;
  const nextName = `state:${input.gameId}:${input.nextStateHash}`;
  const actionName = `${input.gameId}:${input.action}`;

  const prev = kg.upsertEntity({
    name: prevName,
    type: "arc_state",
    properties: { gameId: input.gameId, hash: input.prevStateHash },
  });
  const next = kg.upsertEntity({
    name: nextName,
    type: "arc_state",
    properties: { gameId: input.gameId, hash: input.nextStateHash },
  });
  const actionEntity = kg.upsertEntity({
    name: actionName,
    type: "arc_action",
    properties: { gameId: input.gameId, label: input.action },
  });

  const beforeStats = kg.getStats();

  // Reinforce strength based on whether this transition has been seen
  // before; KnowledgeGraphManager.upsertRelationship averages weights
  // and re-emits the same id if it matches.
  const rel = kg.upsertRelationship({
    sourceName: prev.name,
    sourceType: "arc_state",
    targetName: next.name,
    targetType: "arc_state",
    relationType: "transforms_into",
    weight: Math.max(0.1, Math.min(1, (input.pixelDelta ?? 1) / 64)),
  });
  // Also link action → next state with `produces`.
  kg.upsertRelationship({
    sourceName: actionEntity.name,
    sourceType: "arc_action",
    targetName: next.name,
    targetType: "arc_state",
    relationType: "produces",
    weight: 0.5,
  });

  const afterStats = kg.getStats();
  return {
    transitionId: rel.id,
    edgeReinforced: afterStats.relationshipCount === beforeStats.relationshipCount, // upsert hit existing
    graphSize: {
      entities: afterStats.entityCount,
      relationships: afterStats.activeRelationships,
    },
  };
}

export const LOG_TRANSITION_TOOL_DEF = {
  name: "memory.log_transition",
  title: "Log a state→action→state transition",
  description:
    "Record one (prev_state, action, next_state) tuple into the knowledge graph as arc_state and arc_action entities with transforms_into / produces relationships. Call this after EVERY action so the graph reflects observed dynamics.",
  inputSchema: logTransitionInputSchema,
} as const;
