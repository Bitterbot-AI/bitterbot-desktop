/**
 * memory.get_hypothesis + memory.update_hypothesis — wrap the
 * EpistemicDirectiveEngine to track the agent's current best guess
 * about the game's objective.
 *
 * Hypotheses are stored as `knowledge_gap` directives keyed by game
 * (with the gameId in the `context` field). update_hypothesis with
 * the same text reinforces; a new text supersedes the old one
 * (lower-priority hypothesis is auto-expired).
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

export const getHypothesisInputSchema = {
  gameId: z.string(),
};

export const updateHypothesisInputSchema = {
  gameId: z.string(),
  text: z.string().min(4).describe("Natural-language hypothesis about the game objective."),
  confidence: z.number().min(0).max(1).describe("Confidence in this hypothesis."),
  refute: z
    .boolean()
    .optional()
    .describe(
      "If true, the current top hypothesis is refuted (e.g., GAME_OVER). Confidence becomes 0 and a new hypothesis must be supplied.",
    ),
};

export type GetHypothesisInput = { gameId: string };
export type UpdateHypothesisInput = {
  gameId: string;
  text: string;
  confidence: number;
  refute?: boolean;
};

export interface HypothesisResult {
  gameId: string;
  text: string | null;
  confidence: number;
  directiveId: string | null;
}

const HYPOTHESIS_TAG = "[arc-hypothesis]";

export async function runGetHypothesis(input: GetHypothesisInput): Promise<HypothesisResult> {
  const ctx = await getMemoryContext();
  const directives = ctx.directives;
  if (!directives) {
    return { gameId: input.gameId, text: null, confidence: 0, directiveId: null };
  }
  // EpistemicDirectiveEngine doesn't expose a per-game filter, so we
  // scan the active directives looking for ours.
  const active = directives.getDirectivesForSession();
  const ours = active.find((d) => d.context?.startsWith(`${HYPOTHESIS_TAG}${input.gameId}`));
  if (!ours) {
    return { gameId: input.gameId, text: null, confidence: 0, directiveId: null };
  }
  return {
    gameId: input.gameId,
    text: ours.question,
    confidence: ours.priority,
    directiveId: ours.id,
  };
}

export async function runUpdateHypothesis(input: UpdateHypothesisInput): Promise<HypothesisResult> {
  const ctx = await getMemoryContext();
  const directives = ctx.directives;
  if (!directives) {
    return {
      gameId: input.gameId,
      text: input.refute ? null : input.text,
      confidence: input.refute ? 0 : input.confidence,
      directiveId: null,
    };
  }
  if (input.refute) {
    // Find the current top hypothesis and resolve it.
    const current = await runGetHypothesis({ gameId: input.gameId });
    if (current.directiveId) {
      directives.resolveDirective(current.directiveId, `REFUTED at ${new Date().toISOString()}`);
    }
    return { gameId: input.gameId, text: null, confidence: 0, directiveId: null };
  }
  const directive = directives.createDirective({
    type: "knowledge_gap",
    question: input.text,
    context: `${HYPOTHESIS_TAG}${input.gameId}`,
    priority: input.confidence,
  });
  return {
    gameId: input.gameId,
    text: directive?.question ?? input.text,
    confidence: directive?.priority ?? input.confidence,
    directiveId: directive?.id ?? null,
  };
}

export const GET_HYPOTHESIS_TOOL_DEF = {
  name: "memory.get_hypothesis",
  title: "Read the current goal hypothesis",
  description:
    "Return the agent's current best guess about this game's objective, with confidence. Returns null fields if no hypothesis has been recorded yet.",
  inputSchema: getHypothesisInputSchema,
} as const;

export const UPDATE_HYPOTHESIS_TOOL_DEF = {
  name: "memory.update_hypothesis",
  title: "Update the goal hypothesis",
  description:
    "Set or refine the current hypothesis about the game's objective. Pass refute=true (with any text) to mark the current top hypothesis as refuted (typically called after GAME_OVER).",
  inputSchema: updateHypothesisInputSchema,
} as const;
