/**
 * Bitterbot-native biology adapters for long-horizon Tasks (PLAN-16 Phase E).
 *
 * Pure functions and small helpers that connect the Task primitive to
 * the three biology subsystems: GCCRF curiosity (E.1), the dream engine
 * (E.2), and hormonal modulation (E.3). The subsystems remain the
 * source of truth for their own signals; this module is the *adapter*
 * that lets them participate in task generation and scheduling without
 * coupling their internals to the task store.
 *
 *   E.1  maybeSpawnTaskFromCuriosity(gap)
 *        Called by the curiosity engine when it surfaces a frontier
 *        gap. Decides whether to create a Task with source="curiosity"
 *        based on novelty + alignment thresholds and duplicate
 *        protection.
 *
 *   E.2  scanPendingTasksForDream({maxAgeHours})
 *        Returns a summary of `waiting_external` / `planning` tasks
 *        that a dream cycle should consider when biasing its mode
 *        selection (Replay / Simulation / Mutation toward pending
 *        plans).
 *
 *   E.3  computeTaskConcurrency(hormonalState)
 *        Returns the policy-determined max concurrent task count for
 *        the current hormonal state: cortisol-dominant → focus,
 *        dopamine-dominant → exploration.
 *
 * E.4 (P2P bounty tasks) lives in a sibling file `bounty.ts` and is a
 * thin stub that documents the integration shape without shipping any
 * wallet/payment code (per repo policy, wallet flows are Victor-only).
 */

import type { HormonalState } from "../memory/hormonal.js";
import type { Task, TaskStatus } from "./types.js";
import { getActiveTaskStore } from "./store.js";

// ---------------------------------------------------------------------------
// E.3 — Hormonal concurrency policy.
// ---------------------------------------------------------------------------

export type ConcurrencyPolicy = {
  maxConcurrent: number;
  /** Human-readable explanation surfaced in metrics / dashboards. */
  rationale: string;
  /** Multiplier applied to base priority when scheduling waiting tasks. */
  priorityMultiplier: number;
};

/**
 * Default thresholds, tunable per deployment. Cortisol cutoffs were
 * chosen to align with HormonalBaseline (cortisol baseline = 0.02);
 * mid = ~3× baseline, high = ~30× baseline, matching observed urgency
 * spikes from the curator-stagnation feedback loop.
 */
export const DEFAULT_CONCURRENCY_THRESHOLDS = {
  cortisolHigh: 0.6,
  cortisolMid: 0.3,
  dopamineHigh: 0.6,
  maxParallelFocused: 1,
  maxParallelConservative: 2,
  maxParallelBaseline: 3,
  maxParallelExploration: 4,
} as const;

export type ConcurrencyThresholds = {
  cortisolHigh: number;
  cortisolMid: number;
  dopamineHigh: number;
  maxParallelFocused: number;
  maxParallelConservative: number;
  maxParallelBaseline: number;
  maxParallelExploration: number;
};

export function computeTaskConcurrency(
  state: HormonalState,
  thresholds: ConcurrencyThresholds = DEFAULT_CONCURRENCY_THRESHOLDS,
): ConcurrencyPolicy {
  const { cortisol, dopamine } = state;
  if (cortisol >= thresholds.cortisolHigh) {
    return {
      maxConcurrent: thresholds.maxParallelFocused,
      rationale: "high cortisol — focused single-task mode",
      priorityMultiplier: 1.5,
    };
  }
  if (cortisol >= thresholds.cortisolMid) {
    return {
      maxConcurrent: thresholds.maxParallelConservative,
      rationale: "moderate cortisol — conservative concurrency",
      priorityMultiplier: 1.2,
    };
  }
  if (dopamine >= thresholds.dopamineHigh) {
    return {
      maxConcurrent: thresholds.maxParallelExploration,
      rationale: "high dopamine — exploratory breadth",
      priorityMultiplier: 0.9,
    };
  }
  return {
    maxConcurrent: thresholds.maxParallelBaseline,
    rationale: "baseline",
    priorityMultiplier: 1.0,
  };
}

// ---------------------------------------------------------------------------
// E.1 — Curiosity gap → task spawn.
// ---------------------------------------------------------------------------

/**
 * Minimal shape the curiosity engine reports for a gap. Mirrors the
 * key fields from `GCCRFRewardResult` / `NoveltySignal` so the engine
 * doesn't need to know about Task types.
 */
export type CuriosityGap = {
  /** Stable topic identifier — used for duplicate detection. */
  topic: string;
  /** Human-readable description (becomes the task goal). */
  description: string;
  /** 0..1 — how novel this gap is vs known crystals. */
  novelty: number;
  /** 0..1 — strategic alignment with current Niche / open goals. */
  alignment: number;
  /** 0..1 — estimated effort cost. */
  effort: number;
  /** Optional crystal seed (gap arose from this crystal). */
  seedCrystalId?: string;
};

export type SpawnFromCuriosityOptions = {
  noveltyThreshold?: number; // default 0.6
  alignmentThreshold?: number; // default 0.4
  agentSessionKey?: string | null;
  /** Override default duplicate-protection horizon (default 168h / 7d). */
  duplicateLookbackHours?: number;
};

export function maybeSpawnTaskFromCuriosity(
  gap: CuriosityGap,
  opts: SpawnFromCuriosityOptions = {},
): Task | null {
  const store = getActiveTaskStore();
  if (!store) return null;
  const novelty = opts.noveltyThreshold ?? 0.6;
  const alignment = opts.alignmentThreshold ?? 0.4;
  if (gap.novelty < novelty) return null;
  if (gap.alignment < alignment) return null;

  // Duplicate protection: don't re-spawn for a topic we already have an
  // open or recently-completed curiosity task on.
  const lookbackHours = opts.duplicateLookbackHours ?? 168;
  const sinceTs = Date.now() - lookbackHours * 3_600_000;
  const recent = store.list({
    source: "curiosity",
    sinceTs,
    limit: 200,
  });
  if (recent.some((t) => t.metadata?.topic === gap.topic)) {
    return null;
  }

  return store.create({
    goal: `[curiosity] ${gap.description}`,
    doneCriteria:
      `A reasoned answer or concrete artifact addressing the gap, ` +
      `with at least one cited source or referenced crystal. ` +
      `Topic: ${gap.topic}.`,
    source: "curiosity",
    agentSessionKey: opts.agentSessionKey ?? null,
    metadata: {
      topic: gap.topic,
      novelty: gap.novelty,
      alignment: gap.alignment,
      effort: gap.effort,
      ...(gap.seedCrystalId ? { seedCrystalId: gap.seedCrystalId } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// E.2 — Dream-cycle pending-task scan.
// ---------------------------------------------------------------------------

export type PendingTaskSummary = {
  taskId: string;
  goal: string;
  status: TaskStatus;
  wakeupCount: number;
  ageHours: number;
  pendingHints: string[]; // from latest handoff
  /** Most recent handoff's intent line, for dream-mode bias hints. */
  latestIntent: string | null;
};

export type ScanForDreamOptions = {
  /** Filter to tasks updated within this window. Default 168h (7d). */
  maxAgeHours?: number;
  /** Max rows to return. Default 25. */
  limit?: number;
};

export function scanPendingTasksForDream(opts: ScanForDreamOptions = {}): PendingTaskSummary[] {
  const store = getActiveTaskStore();
  if (!store) return [];
  const maxAgeHours = opts.maxAgeHours ?? 168;
  const limit = opts.limit ?? 25;
  const tasks = store.list({
    status: ["waiting_external", "planning"],
    limit,
  });
  const now = Date.now();
  const cutoff = now - maxAgeHours * 3_600_000;
  return tasks
    .filter((t) => t.updatedAt >= cutoff)
    .map((t) => {
      const handoff = store.latestHandoff(t.id);
      return {
        taskId: t.id,
        goal: t.goal,
        status: t.status,
        wakeupCount: t.wakeupCount,
        ageHours: (now - t.createdAt) / 3_600_000,
        pendingHints: handoff?.pending ?? [],
        latestIntent: handoff?.intent ?? null,
      };
    });
}

// ---------------------------------------------------------------------------
// Combined query: dream-cycle planner snapshot. Convenience that the
// dream engine can call once per cycle to get everything it needs.
// ---------------------------------------------------------------------------

export type DreamPlanningSnapshot = {
  concurrency: ConcurrencyPolicy;
  pending: PendingTaskSummary[];
  /** Tasks that have hit >= half their wakeup cap (signal: stuck). */
  stalled: PendingTaskSummary[];
};

export function buildDreamPlanningSnapshot(
  hormonal: HormonalState,
  opts: {
    wakeupCap?: number;
    scanOpts?: ScanForDreamOptions;
    thresholds?: ConcurrencyThresholds;
  } = {},
): DreamPlanningSnapshot {
  const concurrency = computeTaskConcurrency(hormonal, opts.thresholds);
  const pending = scanPendingTasksForDream(opts.scanOpts);
  const wakeupCap = opts.wakeupCap ?? 50;
  const stalled = pending.filter((p) => p.wakeupCount >= Math.floor(wakeupCap / 2));
  return { concurrency, pending, stalled };
}
