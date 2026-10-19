/**
 * PLAN-57 §4.7, Phase 6: hormonal nudges from compute. Flavour, not
 * function: a small dopamine lift when a job the owner can see succeeds, a
 * small cortisol rise when a worker drops out, the coordinator goes
 * unreachable, or pool embeddings fall back to local for a sustained run.
 *
 * Bounded by construction: one nudge per kind per 30-minute window and a
 * cap per rolling hour across kinds; internal traffic never lifts (callers
 * only nudge successes for owner- or agent-started jobs), and the one
 * internal setback is the sustained-fallback event. The magnitude (0.05, the
 * recall class) and the spacing are chosen so that two nudges of one kind
 * can never add up to the dream engine's hormonal rise trigger (0.15 by
 * default) even before decay: compute colours the mood, it never starts a
 * dream. `compute.awareness.nudges: false` keeps the sink from being
 * registered at all, and without a sink every nudge is a no-op.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("compute/nudges");

export type ComputeNudgeKind = "success" | "setback";

export type ComputeNudge = {
  kind: ComputeNudgeKind;
  /** What happened, for the log; never rendered to the model. */
  reason: string;
  at: number;
};

export type ComputeNudgeSink = (nudge: ComputeNudge) => unknown;

/** At most one nudge of a kind inside this window. */
export const COMPUTE_NUDGE_COOLDOWN_MS = 30 * 60_000;
/** At most this many nudges of any kind per rolling hour. */
export const COMPUTE_NUDGE_HOURLY_CAP = 4;
const HOUR_MS = 60 * 60_000;

let sink: ComputeNudgeSink | null = null;
const lastByKind = new Map<ComputeNudgeKind, number>();
let recent: number[] = [];

export function registerComputeNudgeSink(next: ComputeNudgeSink | null): void {
  sink = next;
}

export function getComputeNudgeSink(): ComputeNudgeSink | null {
  return sink;
}

export function resetComputeNudgesForTest(): void {
  sink = null;
  lastByKind.clear();
  recent = [];
}

/**
 * Apply a nudge if one is due. Returns true when the sink was called.
 * `enabled` is the config switch; callers pass `compute.awareness.nudges`.
 */
export function nudgeCompute(input: {
  kind: ComputeNudgeKind;
  reason: string;
  enabled?: boolean;
  now?: number;
}): boolean {
  if (input.enabled === false || !sink) {
    return false;
  }
  const now = input.now ?? Date.now();
  recent = recent.filter((t) => now - t < HOUR_MS);
  if (recent.length >= COMPUTE_NUDGE_HOURLY_CAP) {
    return false;
  }
  const last = lastByKind.get(input.kind);
  if (last !== undefined && now - last < COMPUTE_NUDGE_COOLDOWN_MS) {
    return false;
  }
  lastByKind.set(input.kind, now);
  recent.push(now);
  try {
    sink({ kind: input.kind, reason: input.reason.slice(0, 120), at: now });
    log.debug(`compute nudge ${input.kind}: ${input.reason}`);
    return true;
  } catch (err) {
    log.debug(`compute nudge sink threw: ${String(err)}`);
    return false;
  }
}
