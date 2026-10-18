/**
 * PLAN-57 §4.2 `compute.estimate`: a deterministic answer to "where would
 * this run, how long, what would it cost", built from the snapshot and a
 * rolling record of past durations. No model call is ever involved; the
 * agent gets a small option table and decides, or a rule decides for it.
 *
 * Durations are learned per (worker, workload) from completed jobs, kept
 * as a short ring so one slow outlier cannot dominate for long. Until a
 * worker has history, a conservative per-item prior is used and the
 * estimate says so (`basis: "prior"`).
 */

import type { ComputeSnapshot, ComputeWorkloadKind, ComputeWorker } from "./backend.js";

const RING = 16;
const PRIOR_MS_PER_ITEM: Record<ComputeWorkloadKind, { gpu: number; cpu: number }> = {
  // Embeddings: a small model on a GPU is ~tens of ms per item; CPU ~hundreds.
  embeddings: { gpu: 40, cpu: 400 },
  // SHA-256 batches are trivially fast anywhere; the fixed overhead dominates.
  sha256: { gpu: 2, cpu: 2 },
};
const FIXED_OVERHEAD_MS = 1500;

type Sample = { items: number; ms: number };
const history = new Map<string, Sample[]>();

function key(workerId: string, workload: ComputeWorkloadKind): string {
  return `${workerId}\u0000${workload}`;
}

/** Record a completed job's duration so later estimates learn from it. */
export function recordComputeDuration(params: {
  workerId: string;
  workload: ComputeWorkloadKind;
  items: number;
  durationMs: number;
}): void {
  if (!(params.items > 0) || !(params.durationMs > 0)) {
    return;
  }
  const k = key(params.workerId, params.workload);
  const ring = history.get(k) ?? [];
  ring.push({ items: params.items, ms: params.durationMs });
  while (ring.length > RING) {
    ring.shift();
  }
  history.set(k, ring);
}

export function resetComputeEstimatesForTest(): void {
  history.clear();
}

/** Median measured ms per item for a worker and workload, or null without history. */
export function learnedMsPerItem(workerId: string, workload: ComputeWorkloadKind): number | null {
  const ring = history.get(key(workerId, workload));
  if (!ring || ring.length === 0) {
    return null;
  }
  const perItem = ring.map((s) => s.ms / s.items).toSorted((a, b) => a - b);
  const mid = Math.floor(perItem.length / 2);
  return perItem.length % 2 === 1 ? perItem[mid] : (perItem[mid - 1] + perItem[mid]) / 2;
}

export type ComputeEstimateOption = {
  worker: string;
  pool?: string;
  gpu: boolean;
  /** Rounded to the nearest second, never below 1. */
  estSeconds: number;
  basis: "history" | "prior";
  /** Credits for credit-settled pools; test USDC for paid; 0 for private/local. */
  cost: { amount: number; unit: "credits" | "usdc" | "free" };
  /** Why the worker is not eligible, when it is not. */
  ineligible?: string;
};

export type ComputeEstimate = {
  workload: ComputeWorkloadKind;
  items: number;
  options: ComputeEstimateOption[];
  /** The option a deterministic rule would pick, or null when nothing is eligible. */
  recommended: ComputeEstimateOption | null;
  note: string;
};

/**
 * Pricing is the coordinator's business; the tool only knows the credit
 * price per item the plugin reports (default 1 credit per item for paid
 * pools, free for private and collective).
 */
export function estimateCompute(params: {
  snapshot: ComputeSnapshot;
  workload: ComputeWorkloadKind;
  items: number;
  /** Required embedding model digest; a worker on another digest is ineligible. */
  modelDigest?: string;
  /** Restrict to a pool or project id. */
  scope?: string;
  creditsPerItem?: number;
}): ComputeEstimate {
  const items = Math.max(1, Math.floor(params.items));
  const options: ComputeEstimateOption[] = [];
  for (const w of params.snapshot.workers) {
    options.push(optionFor(w, params, items));
  }
  // Rule: fastest eligible; ties go to the free option, then to GPU.
  const eligible = options
    .filter((o) => !o.ineligible)
    .toSorted((a, b) => {
      if (a.estSeconds !== b.estSeconds) {
        return a.estSeconds - b.estSeconds;
      }
      if ((a.cost.unit === "free") !== (b.cost.unit === "free")) {
        return a.cost.unit === "free" ? -1 : 1;
      }
      return Number(b.gpu) - Number(a.gpu);
    });
  const recommended = eligible[0] ?? null;
  const note = recommended
    ? recommended.basis === "prior"
      ? "Estimates are priors: no completed jobs on these workers yet."
      : "Estimates use the median of recent completed jobs per worker."
    : params.snapshot.workers.length === 0
      ? "No workers are known. Local processing is the only option."
      : "No eligible worker right now; see each option's reason.";
  return { workload: params.workload, items, options, recommended, note };
}

function optionFor(
  w: ComputeWorker,
  params: {
    workload: ComputeWorkloadKind;
    modelDigest?: string;
    scope?: string;
    creditsPerItem?: number;
  },
  items: number,
): ComputeEstimateOption {
  const pool = params.scope ?? w.pools[0] ?? w.projects[0];
  const learned = learnedMsPerItem(w.id, params.workload);
  const prior = PRIOR_MS_PER_ITEM[params.workload][w.gpu ? "gpu" : "cpu"];
  const perItem = learned ?? prior;
  const estSeconds = Math.max(1, Math.round((FIXED_OVERHEAD_MS + perItem * items) / 1000));
  const paid =
    w.modes.includes("paid") && !w.modes.includes("private") && !w.modes.includes("collective");
  const option: ComputeEstimateOption = {
    worker: w.id,
    gpu: w.gpu,
    estSeconds,
    basis: learned === null ? "prior" : "history",
    cost: paid
      ? { amount: (params.creditsPerItem ?? 1) * items, unit: "credits" }
      : { amount: 0, unit: "free" },
  };
  if (pool) {
    option.pool = pool;
  }
  if (!w.online) {
    option.ineligible = "offline";
  } else if (w.paused) {
    option.ineligible = "paused";
  } else if (
    params.scope &&
    !w.pools.includes(params.scope) &&
    !w.projects.includes(params.scope)
  ) {
    option.ineligible = `not in ${params.scope}`;
  } else if (params.workload === "embeddings" && !w.gpu) {
    option.ineligible = w.gpuUnavailableReason ? `no GPU (${w.gpuUnavailableReason})` : "no GPU";
  } else if (
    params.workload === "embeddings" &&
    params.modelDigest &&
    w.modelDigest &&
    w.modelDigest !== params.modelDigest
  ) {
    option.ineligible = "different embedding model";
  }
  return option;
}
