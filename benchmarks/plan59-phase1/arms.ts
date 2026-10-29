/**
 * PLAN-59 Phase 1: arm construction.
 *
 * Every arm is a list of operations applied, in order, to its own fork of the
 * sealed snapshot. K is 20 or the number of qualifying candidates when fewer,
 * the same K for every arm.
 *
 *   unchanged       no operations
 *   recency         the K candidates whose chunks were most recently accessed
 *   random          K drawn uniformly without replacement under a recorded seed
 *   prioritised     top K by priority (estimate.ts)
 *   shuffled_batch  the prioritised arm's exact set in a seeded random order,
 *                   charged the prioritised arm's selection cost
 */
import { seededShuffle } from "./common.js";
import type { PriorityRow } from "./estimate.js";
import type { Operation } from "./operations.js";

export type ArmName = "unchanged" | "recency" | "random" | "prioritised" | "shuffled_batch";
export const ARMS: readonly ArmName[] = [
  "unchanged",
  "recency",
  "random",
  "prioritised",
  "shuffled_batch",
];

export const DEFAULT_K = 20;

export function chooseK(candidateCount: number, kMax = DEFAULT_K): number {
  return Math.max(0, Math.min(kMax, candidateCount));
}

const byId = (a: Operation, b: Operation) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function selectRecency(candidates: readonly Operation[], k: number): Operation[] {
  return [...candidates]
    .toSorted((a, b) => {
      const ta = a.lastAccessedAt ?? Number.NEGATIVE_INFINITY;
      const tb = b.lastAccessedAt ?? Number.NEGATIVE_INFINITY;
      return tb - ta || byId(a, b);
    })
    .slice(0, k);
}

export function selectRandom(
  candidates: readonly Operation[],
  k: number,
  seed: string,
): Operation[] {
  return seededShuffle([...candidates].toSorted(byId), `${seed}:random`).slice(0, k);
}

/**
 * Top K by priority. Candidates without a priority row (outside the gain
 * estimation cap) rank below every estimated one, by need then id, so the arm
 * is still filled when fewer than K candidates were estimated.
 */
export function selectPrioritised(
  candidates: readonly Operation[],
  k: number,
  rows: ReadonlyMap<string, PriorityRow>,
  needOf: (op: Operation) => number,
): Operation[] {
  return [...candidates]
    .toSorted((a, b) => {
      const ra = rows.get(a.id);
      const rb = rows.get(b.id);
      if (ra && rb) {
        return rb.priority - ra.priority || rb.need - ra.need || byId(a, b);
      }
      if (ra) return -1;
      if (rb) return 1;
      return needOf(b) - needOf(a) || byId(a, b);
    })
    .slice(0, k);
}

export function shuffledBatch(selected: readonly Operation[], seed: string): Operation[] {
  return seededShuffle(selected, `${seed}:shuffled_batch`);
}

export type SelectionCost = {
  forks: number;
  searches: number;
  embeddingCalls: number;
  seconds: number;
};

export const ZERO_SELECTION_COST: SelectionCost = {
  forks: 0,
  searches: 0,
  embeddingCalls: 0,
  seconds: 0,
};

export type ArmPlan = { arm: ArmName; operations: Operation[]; selectionCost: SelectionCost };

export function buildArms(params: {
  candidates: readonly Operation[];
  k: number;
  seed: string;
  priorities: ReadonlyMap<string, PriorityRow>;
  needOf: (op: Operation) => number;
  /** what estimating priorities cost: forks, searches, embedding calls, seconds */
  estimationCost: SelectionCost;
}): Record<ArmName, ArmPlan> {
  const prioritised = selectPrioritised(
    params.candidates,
    params.k,
    params.priorities,
    params.needOf,
  );
  return {
    unchanged: { arm: "unchanged", operations: [], selectionCost: ZERO_SELECTION_COST },
    recency: {
      arm: "recency",
      operations: selectRecency(params.candidates, params.k),
      selectionCost: ZERO_SELECTION_COST,
    },
    random: {
      arm: "random",
      operations: selectRandom(params.candidates, params.k, params.seed),
      selectionCost: ZERO_SELECTION_COST,
    },
    prioritised: {
      arm: "prioritised",
      operations: prioritised,
      selectionCost: params.estimationCost,
    },
    shuffled_batch: {
      arm: "shuffled_batch",
      operations: shuffledBatch(prioritised, params.seed),
      selectionCost: params.estimationCost,
    },
  };
}
