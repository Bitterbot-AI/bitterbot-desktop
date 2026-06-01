/**
 * Zeigarnik tension adapters (PLAN-22 Phase 4).
 *
 * The Zeigarnik effect: unfinished tasks occupy memory and create resumption
 * pressure. These pure adapters quantify that pressure from the set of open
 * tasks and decide, under a throttle, whether the system should proactively
 * resume one. The dream engine and proactive recall consume `tension` to bias
 * toward resolving open loops; that consumer wiring is tracked as a follow-up
 * (this module is intentionally pure and side-effect-free so it can be wired
 * into either consumer without change).
 *
 * Everything here is pure: no clock, no I/O. Callers pass `now`.
 */

import { isTerminal, type TaskStatus } from "./types.js";

/** The minimal task shape the tension calculation needs. */
export interface ZeigarnikTask {
  status: TaskStatus;
  createdAt: number;
  lastSeenAt: number;
}

export interface ZeigarnikModulators {
  /** Stress amplifies the nag of open loops. */
  cortisol?: number;
  /** Reward/drive slightly dampens rumination on the backlog. */
  dopamine?: number;
}

export interface ZeigarnikInput {
  tasks: ZeigarnikTask[];
  now: number;
  hormonal?: ZeigarnikModulators;
}

export interface ZeigarnikTension {
  /** Aggregate resumption pressure, 0..1. */
  tension: number;
  /** Number of open (non-terminal) tasks. */
  pendingCount: number;
  /** Age of the oldest open task, ms. */
  oldestAgeMs: number;
  /** Longest time any open task has gone untouched (stall), ms. */
  maxStallMs: number;
  contributors: string[];
}

// Saturation points for the raw signals.
const COUNT_SATURATION = 5; // 5+ open tasks saturates the count term
const AGE_SATURATION_MS = 24 * 60 * 60 * 1000; // 1 day
const STALL_SATURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

const W = { count: 0.4, age: 0.25, stall: 0.35 } as const;

// Hormonal amplification rails: tension can be scaled within [MIN, MAX].
const AMP_MIN = 0.8;
const AMP_MAX = 1.25;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute aggregate Zeigarnik tension from the open-task set. Pure.
 */
export function computeZeigarnikTension(input: ZeigarnikInput): ZeigarnikTension {
  const open = input.tasks.filter((t) => !isTerminal(t.status));
  const pendingCount = open.length;

  if (pendingCount === 0) {
    return { tension: 0, pendingCount: 0, oldestAgeMs: 0, maxStallMs: 0, contributors: [] };
  }

  const ages = open.map((t) => Math.max(0, input.now - t.createdAt));
  const stalls = open.map((t) => Math.max(0, input.now - t.lastSeenAt));
  const oldestAgeMs = Math.max(...ages);
  const maxStallMs = Math.max(...stalls);

  const countScore = clamp(pendingCount / COUNT_SATURATION, 0, 1);
  const ageScore = clamp(oldestAgeMs / AGE_SATURATION_MS, 0, 1);
  const stallScore = clamp(maxStallMs / STALL_SATURATION_MS, 0, 1);

  const base = countScore * W.count + ageScore * W.age + stallScore * W.stall;

  // Hormonal amplification: cortisol raises tension, dopamine eases it.
  const cortisol = clamp(input.hormonal?.cortisol ?? 0, 0, 1);
  const dopamine = clamp(input.hormonal?.dopamine ?? 0, 0, 1);
  const amp = clamp(1 + 0.25 * cortisol - 0.2 * dopamine, AMP_MIN, AMP_MAX);

  const tension = clamp(base * amp, 0, 1);

  const contributors: string[] = [
    `pending=${pendingCount} (+${(countScore * W.count).toFixed(2)})`,
    `oldestAgeMs=${oldestAgeMs} (+${(ageScore * W.age).toFixed(2)})`,
    `maxStallMs=${maxStallMs} (+${(stallScore * W.stall).toFixed(2)})`,
  ];
  if (cortisol > 0 || dopamine > 0) {
    contributors.push(
      `amp=${amp.toFixed(2)} (cortisol=${cortisol.toFixed(2)} dopamine=${dopamine.toFixed(2)})`,
    );
  }

  return { tension, pendingCount, oldestAgeMs, maxStallMs, contributors };
}

export interface ResumeDecisionInput {
  tension: ZeigarnikTension;
  now: number;
  /** Tension at/above which a resume is warranted. Default 0.5. */
  threshold?: number;
  /** Timestamp of the last tension-driven resume, for throttling. */
  lastResumeAt?: number | null;
  /** Minimum gap between tension-driven resumes. Default 5 minutes. */
  minIntervalMs?: number;
  /** When the user has dismissed the nudge: decay (do not resume). */
  dismissed?: boolean;
}

export interface ResumeDecision {
  resume: boolean;
  reason: string;
}

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Decide whether to proactively resume an open task from tension. Pure.
 * Respects a throttle and decays on user dismissal.
 */
export function maybeResumeFromTension(input: ResumeDecisionInput): ResumeDecision {
  if (input.dismissed) {
    return { resume: false, reason: "dismissed (decaying)" };
  }
  if (input.tension.pendingCount === 0) {
    return { resume: false, reason: "no open tasks" };
  }
  const minInterval = input.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (input.lastResumeAt != null && input.now - input.lastResumeAt < minInterval) {
    return { resume: false, reason: "throttled" };
  }
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  if (input.tension.tension < threshold) {
    return {
      resume: false,
      reason: `tension ${input.tension.tension.toFixed(2)} below ${threshold}`,
    };
  }
  return { resume: true, reason: `tension ${input.tension.tension.toFixed(2)} >= ${threshold}` };
}
