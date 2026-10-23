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
 *   the gateway was down are still reported, once. The local operator's
 *   coordinator boots alongside the gateway, so that first reconcile retries
 *   with backoff for about a minute before an unreachable coordinator is
 *   worth a warning.
 * - Never wakes on worker, GPU, credit or progress changes, and never for
 *   internal-origin jobs.
 */

import { onHeartbeatEvent, type HeartbeatEventPayload } from "../../infra/heartbeat-events.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ComputeBackend, ComputeJobSummary, ComputeSnapshot } from "./backend.js";
import type { ComputeDeliveryStore, ComputeJobOrigin } from "./deliveries.js";
import { emitComputeEpisode, episodeFromJob } from "./episodes.js";
import { nudgeCompute } from "./nudges.js";
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

/** Backoff for the startup reconcile while the coordinator comes up (about a minute in all). */
const STARTUP_RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export type ComputeWatcherOptions = {
  backend: ComputeBackend;
  store: ComputeDeliveryStore;
  /** The owner's main session: where owner-started jobs report. */
  ownerSessionKey: () => string;
  wakeBudgetPerHour?: number;
  /** PLAN-57 Phase 6: hormonal nudges on owner-visible successes and setbacks (compute.awareness.nudges, default on). */
  nudges?: boolean;
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
  // Phase 6: what the previous poll saw, to notice a worker dropping out or
  // the coordinator going away.
  let lastOnlineWorkers: Set<string> | null = null;
  let lastReachable: boolean | null = null;
  let lastPollAt: number | null = null;
  const nudgesOn = opts.nudges !== false;
  // A baseline older than this says nothing about what happened since.
  const baselineMaxAgeMs = 2 * maxPoll;
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
    origin: Exclude<ComputeJobOrigin, "internal">;
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

  /**
   * A worker that was online at the previous poll and is now listed offline,
   * or a coordinator that went away. The previous poll must be recent: after
   * an idle stretch the baseline says nothing about what happened since, and
   * a worker that simply left the pool is not a setback.
   */
  function noticeSetbacks(snapshot: ComputeSnapshot): void {
    const at = now();
    const fresh = lastPollAt !== null && at - lastPollAt <= baselineMaxAgeMs;
    if (fresh && lastReachable === true && !snapshot.reachable) {
      nudgeCompute({
        kind: "setback",
        reason: "coordinator unreachable",
        enabled: nudgesOn,
        now: at,
      });
    }
    lastReachable = snapshot.reachable;
    const byId = new Map(snapshot.workers.map((w) => [w.id, w]));
    if (fresh && lastOnlineWorkers && snapshot.reachable) {
      const lost = [...lastOnlineWorkers].filter((id) => {
        const w = byId.get(id);
        return w !== undefined && !w.online;
      });
      if (lost.length > 0) {
        nudgeCompute({
          kind: "setback",
          reason: `worker offline: ${lost.slice(0, 3).join(", ")}`,
          enabled: nudgesOn,
          now: at,
        });
      }
    }
    if (snapshot.reachable) {
      lastOnlineWorkers = new Set(snapshot.workers.filter((w) => w.online).map((w) => w.id));
    }
    lastPollAt = at;
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
        // §4.7: a finished job the agent or owner started becomes an episode.
        emitComputeEpisode(episodeFromJob(job, route, now()));
        // Phase 6: an owner-visible success the watcher saw in flight is a
        // small lift. A job first seen already finished (reconciled after an
        // outage, or found by a refresh during startup) does not nudge.
        if (job.status === "succeeded" && prev !== undefined) {
          nudgeCompute({ kind: "success", reason: `job ${job.id}`, enabled: nudgesOn, now: now() });
        }
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
      noticeSetbacks(snapshot);
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
    try {
      return await reconcileOnce();
    } catch (err) {
      log.warn(`compute reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /** Reconcile, or throw when the coordinator cannot be read. */
  async function reconcileOnce(): Promise<number> {
    let delivered = 0;
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
          // A job that finished while the gateway was down still resumes
          // its task and still becomes an episode.
          linkTask(route, job);
          emitComputeEpisode(episodeFromJob(job, route, now()));
        }
      }
    }
    lastStatuses = new Map(jobs.map((j) => [j.id, j.status]));
    return delivered;
  }

  function startupReconcile(attempt: number): void {
    void reconcileOnce().then(
      () => watcher.kick(),
      (err: unknown) => {
        if (stopped) {
          return;
        }
        const wait = STARTUP_RETRY_MS[attempt];
        const msg = err instanceof Error ? err.message : String(err);
        if (wait === undefined) {
          log.warn(
            `compute reconcile failed after ${attempt + 1} attempts: ${msg}; polling continues`,
          );
          watcher.kick();
          return;
        }
        log.debug(`compute reconcile not ready (${msg}); retrying in ${wait} ms`);
        setTimer(() => {
          if (!stopped) {
            startupReconcile(attempt + 1);
          }
        }, wait);
      },
    );
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

  startupReconcile(0);
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
