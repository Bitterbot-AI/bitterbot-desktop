/**
 * PLAN-44 Phase 5c: process-wide handle on the skill-evolution model lanes,
 * so an on-demand gateway RPC (routing repair) can use the same calls the
 * dream engine uses, without reaching into the memory manager. Mirrors the
 * `getActiveEventJournal` registry pattern.
 */

import type { LlmCallFn } from "./maintainer.js";

let active: { evolution: LlmCallFn | null; proposer: LlmCallFn | null } = {
  evolution: null,
  proposer: null,
};

export function setActiveEvolutionLlm(lanes: {
  evolution?: LlmCallFn | null;
  proposer?: LlmCallFn | null;
}): void {
  active = { evolution: lanes.evolution ?? null, proposer: lanes.proposer ?? null };
}

/** The proposer lane (agent's primary model) when configured, else the evolution lane. */
export function getActiveEvolutionLlm(): LlmCallFn | null {
  return active.proposer ?? active.evolution;
}
