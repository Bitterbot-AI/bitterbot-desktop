/**
 * Pareto-ranked skill-mutation pool with cosine-decay edit budget (PLAN-21 Phase B).
 *
 * The dream-engine's research mode accumulates a pool of mutation candidates
 * per cycle. Promoting every candidate that clears the validation gate over-
 * mutates the skill and conflicts with SkillReducer's empirical finding that
 * less is more. This module Pareto-ranks the pool over (delta, faithfulness
 * margin, token-delta) and clips to a budget that decays as the skill matures
 * — SkillOpt's cosine schedule (Section 3.4) applied at the pool level rather
 * than the per-skill level.
 *
 * Pure: no I/O, no clock reads. The dream-engine supplies the candidates and
 * the maturity counter; this module is responsible only for the ordering.
 */

/** Defaults for the cosine-decay schedule. */
export const DEFAULT_BUDGET_INITIAL = 4;
export const DEFAULT_BUDGET_FLOOR = 2;
export const DEFAULT_BUDGET_HALF_LIFE_CYCLES = 50;

export interface BudgetOptions {
  /** Maximum atomic edits when a skill is brand-new. */
  initial?: number;
  /** Lower bound the budget can never drop below. */
  floor?: number;
  /** Cycle count at which the budget is halfway between initial and floor. */
  halfLifeCycles?: number;
}

/**
 * Cosine-decay schedule from `initial` to `floor` with the requested half-life
 * (in dream cycles). Pure. Returns an integer (rounded) so callers can use it
 * directly as `Array.slice(0, L_t)`.
 */
export function cosineDecayBudget(dreamCount: number, options: BudgetOptions = {}): number {
  const initial = options.initial ?? DEFAULT_BUDGET_INITIAL;
  const floor = options.floor ?? DEFAULT_BUDGET_FLOOR;
  const halfLife = Math.max(1, options.halfLifeCycles ?? DEFAULT_BUDGET_HALF_LIFE_CYCLES);
  if (dreamCount <= 0) {
    return Math.round(initial);
  }
  // Cosine arch: 1.0 at t=0, 0.0 at t=2*halfLife, clamped beyond.
  const phase = Math.min(Math.PI, (Math.PI * dreamCount) / (2 * halfLife));
  const arch = (1 + Math.cos(phase)) / 2; // 1.0 → 0.0 over [0, 2*halfLife]
  const value = floor + (initial - floor) * arch;
  return Math.max(Math.round(floor), Math.round(value));
}

// ── Pareto front ──────────────────────────────────────────────────────────

export type AxisDirection = "max" | "min";

export interface ParetoAxis<T> {
  readonly name: string;
  readonly direction: AxisDirection;
  readonly value: (candidate: T) => number;
  /** Optional per-axis floor below which a candidate is excluded entirely. */
  readonly floor?: number;
}

/**
 * Return the non-dominated subset of `candidates` over the provided axes.
 * Each candidate must satisfy every axis floor (when set) or it is excluded
 * before dominance is checked. This prevents single-axis winners from sneaking
 * onto the front when they failed a hard requirement.
 *
 * Stable: relative order of front members matches their input order.
 */
export function paretoFront<T>(
  candidates: ReadonlyArray<T>,
  axes: ReadonlyArray<ParetoAxis<T>>,
): T[] {
  if (axes.length === 0) {
    return [...candidates];
  }
  const eligible = candidates.filter((c) => respectsFloors(c, axes));
  const out: T[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const a = eligible[i]!;
    let dominated = false;
    for (let j = 0; j < eligible.length; j++) {
      if (i === j) {
        continue;
      }
      const b = eligible[j]!;
      if (dominates(b, a, axes)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      out.push(a);
    }
  }
  return out;
}

function respectsFloors<T>(c: T, axes: ReadonlyArray<ParetoAxis<T>>): boolean {
  for (const axis of axes) {
    if (axis.floor === undefined) {
      continue;
    }
    const v = axis.value(c);
    if (axis.direction === "max" ? v < axis.floor : v > axis.floor) {
      return false;
    }
  }
  return true;
}

/**
 * Does `b` dominate `a`? `b` dominates `a` iff `b` is no worse on every axis
 * and strictly better on at least one.
 */
function dominates<T>(b: T, a: T, axes: ReadonlyArray<ParetoAxis<T>>): boolean {
  let strictlyBetterSomewhere = false;
  for (const axis of axes) {
    const bv = axis.value(b);
    const av = axis.value(a);
    if (axis.direction === "max") {
      if (bv < av) {
        return false;
      }
      if (bv > av) {
        strictlyBetterSomewhere = true;
      }
    } else {
      if (bv > av) {
        return false;
      }
      if (bv < av) {
        strictlyBetterSomewhere = true;
      }
    }
  }
  return strictlyBetterSomewhere;
}

// ── Top-L selection ────────────────────────────────────────────────────────

export type TieBreak<T> = (candidate: T) => number;

/**
 * Clip the supplied front to at most `L` entries. When the front exceeds L,
 * the tie-break accessor decides which to keep (highest values win). When
 * `L >= front.length` the input is returned unchanged.
 *
 * Stable for equal tie-break scores: relative order from the input is
 * preserved. Tests rely on this stability.
 */
export function selectTopL<T>(front: ReadonlyArray<T>, L: number, tieBreak: TieBreak<T>): T[] {
  if (L <= 0) {
    return [];
  }
  if (front.length <= L) {
    return [...front];
  }
  // Tag-and-stable-sort: keep input order on equal scores.
  const tagged = front.map((entry, index) => ({ entry, index, score: tieBreak(entry) }));
  tagged.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.index - b.index;
  });
  return tagged.slice(0, L).map((t) => t.entry);
}

// ── PLAN-21 axis presets ───────────────────────────────────────────────────

/**
 * The three axes PLAN-21 ranks mutation candidates on.
 *
 * - `delta` (max): improvement margin from the bootstrap CI; require ≥ 0.
 * - `faithfulnessMargin` (max): 1 minus the share of concepts the mutation
 *   dropped. A faithfulness-passing mutation has margin 1.0; partial
 *   preservation produces a value in (0, 1).
 * - `tokenDelta` (min): difference in skill text length. Negative values mean
 *   the mutation compressed the skill, which SkillReducer found correlates
 *   with quality improvements. We do not require a hard floor here — let
 *   compression and growth fight it out on the front.
 */
export interface MutationPoolCandidate {
  readonly delta: number;
  readonly faithfulnessMargin: number;
  readonly tokenDelta: number;
}

export function defaultPlan21Axes<T extends MutationPoolCandidate>(): ParetoAxis<T>[] {
  return [
    { name: "delta", direction: "max", value: (c) => c.delta, floor: 0 },
    {
      name: "faithfulnessMargin",
      direction: "max",
      value: (c) => c.faithfulnessMargin,
      floor: 0.5,
    },
    { name: "tokenDelta", direction: "min", value: (c) => c.tokenDelta },
  ];
}

/** Default tie-break: highest delta wins. */
export function defaultPlan21TieBreak<T extends MutationPoolCandidate>(): TieBreak<T> {
  return (c) => c.delta;
}
