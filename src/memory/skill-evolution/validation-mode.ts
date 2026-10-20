/**
 * PLAN-44 Phase 2 (D-2): the EFFECTIVE validation mode.
 *
 * `records` mode is an LLM opinion poll over past traces with the
 * candidate text visible to the judge (audit §4.3) and stays available
 * only as an explicit opt-in. When the operator has not set
 * `skills.evolution.validationMode`, the loop flips to `tasks` the moment
 * the effective corpus carries enough reviewed capability tasks for the
 * sign test to be reachable (p < 0.05 needs >= 5 discordant tasks). Below
 * that threshold a fresh node stays on records mode rather than holding
 * every proposal forever.
 */

import type { TaskCorpus } from "./task-corpus.js";

export type ValidationMode = "records" | "tasks";

/** Reviewed capability tasks needed before tasks mode is reachable at all. */
export const TASKS_MODE_MIN_CAPABILITY_TASKS = 5;

export function countCapabilityTasks(corpus: TaskCorpus | null): number {
  return corpus ? corpus.tasks.filter((t) => t.suite !== "regression").length : 0;
}

/** Pure: explicit config wins; otherwise tasks iff the corpus can carry signal. */
export function resolveEffectiveValidationMode(
  explicit: ValidationMode | undefined,
  capabilityTaskCount: number,
): { mode: ValidationMode; source: "config" | "auto" } {
  if (explicit === "tasks") {
    return { mode: "tasks", source: "config" };
  }
  // PLAN-45 2.8 (D-7): explicit "records" no longer selects a promoting
  // gate. It is honoured only as "run the diagnostic judge"; the auto rule
  // below still decides whether tasks mode is reachable.
  return {
    mode: capabilityTaskCount >= TASKS_MODE_MIN_CAPABILITY_TASKS ? "tasks" : "records",
    source: "auto",
  };
}
