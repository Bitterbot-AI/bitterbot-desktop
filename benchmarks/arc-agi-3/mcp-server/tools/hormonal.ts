/**
 * memory.get_hormonal_state + memory.record_event — read and modulate
 * the agent's hormonal state. The state biases retrieval breadth in
 * SAGE Phase 5 (cortisol narrows, dopamine widens, oxytocin boosts
 * social-relation edges).
 *
 * In ARC-AGI-3 terms:
 *   - "achievement" event after a level-up
 *   - "error" event after a GAME_OVER
 *   - "curiosity_high" event after a novel-action reward
 */

import { z } from "zod";
import { getMemoryContext } from "../context.js";

const ARC_EVENTS = [
  "reward",
  "error",
  "achievement",
  "urgency",
  "curiosity_high",
  "curiosity_progress",
  "curiosity_stagnant",
] as const;
type ArcEvent = (typeof ARC_EVENTS)[number];

export const getHormonalInputSchema = {};
export const recordEventInputSchema = {
  event: z
    .enum(ARC_EVENTS)
    .describe(
      "The hormonal event. 'achievement' on level-up, 'error' on GAME_OVER, 'curiosity_high' on novel action.",
    ),
};

export type GetHormonalInput = Record<string, never>;
export type RecordEventInput = { event: ArcEvent };

export interface HormonalStateResult {
  dopamine: number;
  cortisol: number;
  oxytocin: number;
  available: boolean;
}

export async function runGetHormonal(_: GetHormonalInput): Promise<HormonalStateResult> {
  const ctx = await getMemoryContext();
  const h = ctx.hormones;
  if (!h) {
    return { dopamine: 0, cortisol: 0, oxytocin: 0, available: false };
  }
  const s = h.getState();
  return {
    dopamine: s.dopamine,
    cortisol: s.cortisol,
    oxytocin: s.oxytocin,
    available: true,
  };
}

export async function runRecordEvent(input: RecordEventInput): Promise<HormonalStateResult> {
  const ctx = await getMemoryContext();
  const h = ctx.hormones;
  if (h) {
    h.stimulate(input.event as Parameters<typeof h.stimulate>[0]);
  }
  return runGetHormonal({});
}

export const GET_HORMONAL_TOOL_DEF = {
  name: "memory.get_hormonal_state",
  title: "Read hormonal state",
  description:
    "Return the agent's current {dopamine, cortisol, oxytocin} levels (each in 0..1). High cortisol → narrow exploration; high dopamine → broad exploration.",
  inputSchema: getHormonalInputSchema,
} as const;

export const RECORD_EVENT_TOOL_DEF = {
  name: "memory.record_event",
  title: "Record a hormonal event",
  description:
    "Record an event that modulates hormonal state. Use 'achievement' on level-up, 'error' on GAME_OVER, 'curiosity_high' on a novel action that produced a frame change.",
  inputSchema: recordEventInputSchema,
} as const;
