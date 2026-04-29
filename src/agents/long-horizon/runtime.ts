/**
 * Long-horizon work-rest-dream runtime (PLAN-14 Pillar 5).
 *
 * Drives an agent task through a biological cycle of work, rest, and
 * dream phases. Each phase boundary writes a checkpoint to
 * CheckpointStore so a 6+ hour run can be paused, resumed from any
 * intermediate tip, or forked into a parallel exploration.
 *
 * The runtime is deliberately decoupled from any specific agent
 * runner — callers supply a `workStep` function that does one unit of
 * work and a `dreamStep` function that runs the dream pass. This lets
 * the same driver power CLI runs, gateway-backed runs, and isolated
 * sandboxed runs without each owning its own loop logic.
 *
 * Phases:
 *   work    — caller's workStep() runs until elapsed >= workMs.
 *   rest    — short cool-down, no work step. Cortisol decay window.
 *   dream   — dreamStep() runs once; insights surface for next work cycle.
 *
 * The cycle repeats until a stop condition fires:
 *   - max wall-clock budget hit
 *   - max iteration cap hit
 *   - workStep returns { done: true }
 *   - external abort signal
 */

import { CheckpointStore } from "../../checkpoints/store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withSpan } from "../../observability/otel.js";

const log = createSubsystemLogger("long-horizon/runtime");

export type Phase = "work" | "rest" | "dream";

export type WorkStepResult<T = unknown> = {
  /** When true, the runtime stops after this work step (task complete). */
  done?: boolean;
  /** Optional partial state to checkpoint. Defaults to undefined. */
  state?: T;
  /** Optional human-readable label for the checkpoint timeline. */
  label?: string;
};

export type LongHorizonOptions<T = unknown> = {
  /** Stable id for this run; used as the checkpoint thread_id. */
  threadId: string;
  /** Work-phase duration before yielding to rest. Default 25 min. */
  workMs?: number;
  /** Rest-phase duration. Default 2 min. */
  restMs?: number;
  /** Hard wall-clock budget for the entire run. Default 8h. */
  budgetMs?: number;
  /** Hard iteration cap (work cycles). Default 200. */
  maxIterations?: number;
  /** One unit of agent work; called until it sets done or time elapses. */
  workStep: () => Promise<WorkStepResult<T>>;
  /** One pass of the dream engine; run once at the end of each cycle. */
  dreamStep?: () => Promise<{ label?: string; state?: unknown } | void>;
  /** External cancel signal; checked before each work step. */
  signal?: AbortSignal;
  /** Checkpoint store; defaults to no checkpointing. */
  store?: CheckpointStore;
  /** Sleep impl (test seam). Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock impl (test seam). Defaults to Date.now. */
  now?: () => number;
};

export type LongHorizonStats = {
  cycles: number;
  workSteps: number;
  dreamSteps: number;
  startedAt: number;
  endedAt: number;
  reason: "done" | "budget" | "iterations" | "aborted";
  lastStepId: string | null;
};

const DEFAULT_WORK_MS = 25 * 60 * 1000;
const DEFAULT_REST_MS = 2 * 60 * 1000;
const DEFAULT_BUDGET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_ITERATIONS = 200;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class LongHorizonRuntime<T = unknown> {
  private readonly opts: Required<Omit<LongHorizonOptions<T>, "signal" | "store" | "dreamStep">> & {
    signal?: AbortSignal;
    store?: CheckpointStore;
    dreamStep?: () => Promise<{ label?: string; state?: unknown } | void>;
  };
  private parentStepId: string | null = null;
  private stepCounter = 0;

  constructor(opts: LongHorizonOptions<T>) {
    this.opts = {
      threadId: opts.threadId,
      workMs: opts.workMs ?? DEFAULT_WORK_MS,
      restMs: opts.restMs ?? DEFAULT_REST_MS,
      budgetMs: opts.budgetMs ?? DEFAULT_BUDGET_MS,
      maxIterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      workStep: opts.workStep,
      dreamStep: opts.dreamStep,
      sleep: opts.sleep ?? defaultSleep,
      now: opts.now ?? Date.now,
      signal: opts.signal,
      store: opts.store,
    };
  }

  /**
   * Drive the work-rest-dream loop until a stop condition fires.
   * Returns a stats summary; full lineage is in the checkpoint store
   * when one was supplied.
   */
  async run(): Promise<LongHorizonStats> {
    return withSpan("long_horizon.run", () => this.runInner(), {
      "long_horizon.thread_id": this.opts.threadId,
    });
  }

  private async runInner(): Promise<LongHorizonStats> {
    const stats: LongHorizonStats = {
      cycles: 0,
      workSteps: 0,
      dreamSteps: 0,
      startedAt: this.opts.now(),
      endedAt: 0,
      reason: "done",
      lastStepId: null,
    };

    while (true) {
      if (this.opts.signal?.aborted) {
        stats.reason = "aborted";
        break;
      }
      if (stats.cycles >= this.opts.maxIterations) {
        stats.reason = "iterations";
        break;
      }
      if (this.opts.now() - stats.startedAt >= this.opts.budgetMs) {
        stats.reason = "budget";
        break;
      }

      // ---------- WORK PHASE ----------
      const workEndsAt = this.opts.now() + this.opts.workMs;
      let lastWork: WorkStepResult<T> = {};
      while (this.opts.now() < workEndsAt) {
        if (this.opts.signal?.aborted) {
          stats.reason = "aborted";
          break;
        }
        lastWork = await withSpan("long_horizon.work_step", () => this.opts.workStep(), {
          phase: "work",
          cycle: stats.cycles,
        });
        stats.workSteps += 1;
        await this.checkpoint("work", lastWork.state, lastWork.label);
        if (lastWork.done) {
          stats.reason = "done";
          break;
        }
      }
      if (stats.reason === "done" && lastWork.done) {
        break;
      }
      if (stats.reason === "aborted") {
        break;
      }

      // ---------- REST PHASE ----------
      await this.checkpoint("rest", undefined, "rest start");
      await this.opts.sleep(this.opts.restMs);
      if (this.opts.signal?.aborted) {
        stats.reason = "aborted";
        break;
      }

      // ---------- DREAM PHASE ----------
      if (this.opts.dreamStep) {
        const dreamResult = await withSpan(
          "long_horizon.dream_step",
          async () => {
            const r = await this.opts.dreamStep!();
            return r ?? {};
          },
          { phase: "dream", cycle: stats.cycles },
        );
        stats.dreamSteps += 1;
        await this.checkpoint("dream", dreamResult?.state, dreamResult?.label ?? "dream");
      }

      stats.cycles += 1;
    }

    stats.endedAt = this.opts.now();
    stats.lastStepId = this.parentStepId;
    log.info(
      `long-horizon run finished thread=${this.opts.threadId} cycles=${stats.cycles} reason=${stats.reason}`,
    );
    return stats;
  }

  /**
   * Resume a thread from its latest checkpoint tip. Returns the most
   * recent step id so the caller can continue the lineage.
   */
  static resume(threadId: string, store: CheckpointStore): string | null {
    const list = store.list(threadId, { limit: 5_000 });
    if (list.length === 0) return null;
    return list[list.length - 1].stepId;
  }

  private async checkpoint(phase: Phase, state: unknown, label?: string): Promise<void> {
    const store = this.opts.store;
    if (!store) return;
    this.stepCounter += 1;
    const stepId = `${this.opts.threadId}:${phase}:${this.stepCounter}`;
    try {
      store.save({
        threadId: this.opts.threadId,
        stepId,
        parentStepId: this.parentStepId,
        kind: "custom",
        state: { phase, ...(state !== undefined ? { state } : {}) },
        label: label ?? `phase=${phase}`,
        metadata: { phase, cycle: this.stepCounter },
      });
      this.parentStepId = stepId;
    } catch (err) {
      log.warn(`checkpoint write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
