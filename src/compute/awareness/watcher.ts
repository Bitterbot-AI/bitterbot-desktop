/**
 * PLAN-57 §4.4: the compute watcher. Gateway side, no LLM.
 *
 * - Polls the backend with backoff (2 s while a job is in flight, growing to
 *   30 s) and stops when nothing is in flight; `kick()` restarts it when a
 *   job is submitted. Idle node: zero ticks.
 * - Publishes the snapshot the `<compute-state>` block and the tool read.
 * - On a terminal or owner-facing transition of an agent- or owner-started
 *   job: records a durable delivery, enqueues a system event into the
 *   origin session, and wakes the heartbeat with reason `compute-event`,
 *   under a per-hour wake budget. Over budget: the event is still enqueued
 *   and the row is deferred; nothing is dropped.
 * - Marks rows delivered when a heartbeat turn completes for that session.
 * - On start, reconciles against the coordinator so jobs that finished while
 *   the gateway was down are still reported, once.
 * - Never wakes on worker, GPU, credit or progress changes, and never for
 *   internal-origin jobs.
 */

import { onHeartbeatEvent, type HeartbeatEventPayload } from "../../infra/heartbeat-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ComputeBackend, ComputeJobSummary, ComputeSnapshot } from "./backend.js";
import type { ComputeDeliveryStore, ComputeJobOrigin } from "./deliveries.js";
import {
  publishComputeSnapshot,
  pushComputeTransition,
  setComputeDeferredCount,
  setComputeInternalJobs,
} from "./state.js";
import { completeComputeTaskLink } from "./task-link.js";

const log = createSubsystemLogger("compute/watcher");

export const COMPUTE_WAKE_REASON = "compute-event";

/** Transitions worth telling the agent about, once each. */
export const DELIVERABLE_STATUSES = new Set([
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "awaiting_payment",
  "payment_review",
]);

const IN_FLIGHT = new Set(["queued", "running", "settlement_pending"]);

export type ComputeWatcherOptions = {
  backend: ComputeBackend;
  store: ComputeDeliveryStore;
  /** The owner's main session: where owner-started jobs report. */
  ownerSessionKey: () => string;
  wakeBudgetPerHour?: number;
  minPollMs?: number;
  maxPollMs?: number;
  reconcileLimit?: number;
  // Test seams.
  enqueue?: typeof enqueueSystemEvent;
  wake?: (opts: { reason: string }) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  subscribeHeartbeat?: (listener: (evt: HeartbeatEventPayload) => void) => () => void;
  completeTaskLink?: typeof completeComputeTaskLink;
};

export type ComputeWatcher = {
  /** A job was submitted: poll now and keep polling while it runs. */
  kick(): void;
  /** One poll, awaited. Used by tests and by the plugin's RPC refresh. */
  pollOnce(): Promise<ComputeSnapshot | null>;
  /** Reconcile deliveries against the coordinator (also run at start). */
  reconcile(): Promise<number>;
  stop(): void;
  isPolling(): boolean;
};

export function startComputeWatcher(opts: ComputeWatcherOptions): ComputeWatcher {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const enqueue = opts.enqueue ?? enqueueSystemEvent;
  const wake = opts.wake ?? ((o) => requestHeartbeatNow(o));
  const subscribe = opts.subscribeHeartbeat ?? onHeartbeatEvent;
  const budget = Math.max(0, opts.wakeBudgetPerHour ?? 20);
  const minPoll = opts.minPollMs ?? 2_000;
  const maxPoll = opts.maxPollMs ?? 30_000;

  let timer: unknown = null;
  let delay = minPoll;
  let stopped = false;
  let polling = false;
  let lastStatuses = new Map<string, string>();
  const wakes: number[] = [];

  const unsubscribe = subscribe((evt) => {
    if (evt.status === "skipped" || evt.status === "failed") {
      return;
    }
    const n = opts.store.markDeliveredUpTo(opts.ownerSessionKey(), evt.ts);
    if (n > 0) {
      setComputeDeferredCount(opts.store.deferredCount());
    }
  });

  function withinBudget(): boolean {
    const cutoff = now() - 60 * 60_000;
    while (wakes.length > 0 && wakes[0] < cutoff) {
      wakes.shift();
    }
    return wakes.length < budget;
  }

  function budgetResetsAt(): number {
    return wakes.length > 0 ? wakes[0] + 60 * 60_000 : now();
  }

  function deliver(job: ComputeJobSummary, sessionKey: string, created: boolean): void {
    const text = formatTransition(job);
    const contextKey = `compute-job:${job.id}:${job.status}`;
    if (created) {
      pushComputeTransition({
        jobId: job.id,
        status: job.status,
        summary: summarise(job),
        at: now(),
      });
    }
    enqueue(text, { sessionKey, contextKey });
    if (withinBudget()) {
      wakes.push(now());
      opts.store.markEnqueued(job.id, job.status, { now: now() });
      wake({ reason: COMPUTE_WAKE_REASON });
    } else {
      opts.store.markEnqueued(job.id, job.status, { now: now(), deferredUntil: budgetResetsAt() });
      log.info(`compute delivery deferred (wake budget spent) job=${job.id} status=${job.status}`);
    }
    setComputeDeferredCount(opts.store.deferredCount());
  }

  function routeFor(job: ComputeJobSummary): {
    sessionKey: string;
    origin: ComputeJobOrigin;
    taskId: string | null;
    wakeupJobId: string | null;
  } | null {
    const origin = opts.store.originOf(job.id);
    if (!origin) {
      return null;
    }
    if (origin.origin === "internal") {
      return null;
    }
    return {
      sessionKey: origin.sessionKey ?? opts.ownerSessionKey(),
      origin: origin.origin,
      taskId: origin.taskId,
      wakeupJobId: origin.wakeupJobId,
    };
  }

  /** PLAN-16 linkage (§4.5): record the outcome on the task and resume it now. */
  function linkTask(
    route: { taskId: string | null; wakeupJobId: string | null },
    job: ComputeJobSummary,
  ): void {
    if (!route.taskId) {
      return;
    }
    const complete = opts.completeTaskLink ?? completeComputeTaskLink;
    void complete({ taskId: route.taskId, wakeupJobId: route.wakeupJobId, job }).catch((err) => {
      log.warn(
        `compute task link failed job=${job.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  function handleTransitions(jobs: ComputeJobSummary[]): void {
    for (const job of jobs) {
      const prev = lastStatuses.get(job.id);
      if (prev === job.status || !DELIVERABLE_STATUSES.has(job.status)) {
        continue;
      }
      const route = routeFor(job);
      if (!route) {
        continue;
      }
      const created = opts.store.createDelivery(job.id, job.status, route.sessionKey, now());
      if (!created && !isUndelivered(job)) {
        continue;
      }
      deliver(job, route.sessionKey, created);
      if (created) {
        linkTask(route, job);
      }
    }
  }

  function isUndelivered(job: ComputeJobSummary): boolean {
    return opts.store
      .pending()
      .some((r) => r.jobId === job.id && r.transition === job.status && r.enqueuedAt === null);
  }

  function retryDeferred(): void {
    for (const row of opts.store.dueDeferred(now())) {
      if (!withinBudget()) {
        break;
      }
      wakes.push(now());
      opts.store.markEnqueued(row.jobId, row.transition, { now: now() });
      wake({ reason: COMPUTE_WAKE_REASON });
    }
    setComputeDeferredCount(opts.store.deferredCount());
  }

  async function pollOnce(): Promise<ComputeSnapshot | null> {
    if (polling) {
      return null;
    }
    polling = true;
    try {
      const snapshot = await opts.backend.snapshot();
      publishComputeSnapshot(snapshot);
      setComputeInternalJobs(opts.store.internalJobIds());
      handleTransitions(snapshot.jobs);
      lastStatuses = new Map(snapshot.jobs.map((j) => [j.id, j.status]));
      retryDeferred();
      return snapshot;
    } catch (err) {
      log.warn(`compute poll failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      polling = false;
    }
  }

  function hasWorkInFlight(snapshot: ComputeSnapshot | null): boolean {
    return (
      Boolean(snapshot?.jobs.some((j) => IN_FLIGHT.has(j.status))) || opts.store.deferredCount() > 0
    );
  }

  function schedule(ms: number): void {
    if (stopped) {
      return;
    }
    if (timer !== null) {
      clearTimer(timer);
    }
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  }

  async function tick(): Promise<void> {
    const snapshot = await pollOnce();
    if (stopped) {
      return;
    }
    if (hasWorkInFlight(snapshot)) {
      delay = Math.min(maxPoll, Math.round(delay * 1.5));
      schedule(delay);
    } else {
      delay = minPoll;
      timer = null;
    }
  }

  async function reconcile(): Promise<number> {
    let delivered = 0;
    try {
      const jobs = await opts.backend.jobs({ limit: opts.reconcileLimit ?? 200 });
      for (const job of jobs) {
        if (!DELIVERABLE_STATUSES.has(job.status)) {
          continue;
        }
        const route = routeFor(job);
        if (!route) {
          continue;
        }
        const created = opts.store.createDelivery(job.id, job.status, route.sessionKey, now());
        if (created || isUndelivered(job)) {
          deliver(job, route.sessionKey, created);
          delivered += 1;
          if (created) {
            // A job that finished while the gateway was down still resumes its task.
            linkTask(route, job);
          }
        }
      }
      lastStatuses = new Map(jobs.map((j) => [j.id, j.status]));
    } catch (err) {
      log.warn(`compute reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return delivered;
  }

  const watcher: ComputeWatcher = {
    kick() {
      if (stopped) {
        return;
      }
      delay = minPoll;
      schedule(0);
    },
    pollOnce,
    reconcile,
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      unsubscribe();
    },
    isPolling() {
      return timer !== null;
    },
  };

  void reconcile().then(() => watcher.kick());
  return watcher;
}

function summarise(job: ComputeJobSummary): string {
  const where = job.worker ? ` on ${job.worker}` : "";
  const ver = job.verification ? `, ${job.verification}` : "";
  return `${job.workload} x${job.items}${where}${ver}`;
}

export function formatTransition(job: ComputeJobSummary): string {
  const scope = job.scope ? ` in ${job.scope}` : "";
  const where = job.worker ? ` on ${job.worker}` : "";
  const ver = job.verification ? ` Verification: ${job.verification}.` : "";
  const err = job.error ? ` Error: ${job.error}.` : "";
  if (job.status === "awaiting_payment") {
    const cost = job.awaitingUsdc !== undefined ? ` for ${job.awaitingUsdc} test USDC` : "";
    return `[compute awaiting_payment] Job ${job.id} (${job.workload}, ${job.items} items)${scope} is quoted${cost} and waits for the owner to fund it. You cannot fund it; say what it would cost.`;
  }
  if (job.status === "payment_review") {
    return `[compute payment_review] Job ${job.id} (${job.workload}, ${job.items} items)${scope} needs the owner's attention: its funding did not match the quote.`;
  }
  return `[compute ${job.status}] Job ${job.id} (${job.workload}, ${job.items} items)${scope}${where}.${ver}${err}`;
}
