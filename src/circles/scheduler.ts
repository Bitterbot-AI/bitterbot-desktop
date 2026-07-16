/**
 * PLAN-36 Phase 0: the fast circles scheduler.
 *
 * PLAN-31 ran mailbox drain + presence heartbeat inside the memory
 * consolidation tick (default every 30 min). That made inbound messages up to
 * 30 min late and made presence structurally stale (a 30-min beat can never
 * satisfy the UI's 10-min "online" window). This module drains the mailbox on a
 * ~15s self-rescheduling loop and beats presence on a ~30s sub-cadence, so
 * delivery feels near-real-time and the online dot becomes truthful.
 *
 * Design notes:
 *  - Self-rescheduling setTimeout (NOT setInterval): the next cycle is only
 *    scheduled after the current one finishes, so a slow cycle can never stack
 *    on itself and starve the event loop (the gateway's documented failure
 *    mode). Fan-out is already bounded-parallel with per-dial timeouts.
 *  - Idle backoff: when the node has no active non-practice circle there is
 *    nothing to poll or beat, so it falls back to a slow interval until a
 *    connection exists.
 *  - Presence sub-cadence: presence beats are throttled to ~30s (independent of
 *    the ~15s poll) so total beats stay within the legacy per-author receive
 *    limit for typical circle-sharing, avoiding rate-limiting by older peers
 *    (see the version-skew note in src/gateway/a2a/circles.ts).
 *
 * The heavy dependencies (config, DB, service) are injected so the loop is unit
 * testable with fake timers and a stub service.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("circles/scheduler");

/** The subset of CirclesService the scheduler drives. */
export type SchedulableCirclesService = {
  hasActiveCircles(): boolean;
  pollMailbox(): Promise<{ received: number; dispatched: number }>;
  heartbeat(): Promise<unknown>;
  /** PLAN-36 Phase 4: keep mesh-topic subscriptions current (optional). */
  ensureCircleSubscriptions?(): Promise<void>;
  /** PLAN-36 §4: re-post pending mailbox joins until their welcome lands (optional). */
  repostPendingJoins?(): Promise<number>;
};

export type CirclesSchedulerDeps = {
  /** Re-read each cycle so a config hot-reload (circles.enabled) takes effect. */
  getConfig: () => { circles?: { enabled?: boolean } };
  /**
   * Build/return the service for this cycle, or undefined if the circles DB
   * (memory manager) is not ready yet. Called every active cycle; expected to
   * be cheap (the manager caches).
   */
  resolveService: () => Promise<SchedulableCirclesService | undefined>;
  /** Mailbox drain cadence while active. Default 15s. */
  pollIntervalMs?: number;
  /** Presence beat sub-cadence. Default 30s. */
  presenceIntervalMs?: number;
  /** Cadence while disabled or with no active circle. Default 5 min. */
  idleIntervalMs?: number;
  /**
   * Fired when a mailbox drain delivered ≥1 inbound message, so the host can
   * push a "circles" event to the UI (mirrors the direct-dial path). Best-
   * effort; the scheduler swallows throws.
   */
  onInbound?: (info: { count: number }) => void;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type CirclesSchedulerHandle = { stop: () => void };

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_PRESENCE_MS = 30_000;
const DEFAULT_IDLE_MS = 5 * 60_000;

/**
 * Start the fast circles loop. Runs one cycle immediately (so a node that boots
 * with pending mail drains it in seconds, not after the first 30-min tick),
 * then self-reschedules. Returns a handle whose stop() cancels the pending
 * timer; the gateway close handler must call it.
 */
export function startCirclesScheduler(deps: CirclesSchedulerDeps): CirclesSchedulerHandle {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const presenceMs = deps.presenceIntervalMs ?? DEFAULT_PRESENCE_MS;
  const idleMs = deps.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const now = deps.now ?? Date.now;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPresenceAt = 0;
  let announcedActive = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void cycle(), ms);
    // Don't keep the process alive on this timer alone.
    timer.unref?.();
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    let nextMs = pollMs;
    try {
      if (deps.getConfig().circles?.enabled !== true) {
        nextMs = idleMs;
        return;
      }
      const service = await deps.resolveService();
      if (!service || !service.hasActiveCircles()) {
        nextMs = idleMs;
        return;
      }
      if (!announcedActive) {
        announcedActive = true;
        // One-shot so the boot log confirms the fast loop is live (not
        // wired-but-dead) and at what cadence.
        log.info(`fast scheduler active (poll ${pollMs}ms, presence ${presenceMs}ms)`);
      }
      // Keep mesh-topic subscriptions current (new circles, epoch bumps).
      await service.ensureCircleSubscriptions?.();
      // Re-post any join awaiting an offline inviter, THEN drain (so a welcome
      // that crossed with our re-post is imported in the same cycle).
      await service.repostPendingJoins?.();
      const drained = await service.pollMailbox();
      if (drained.dispatched > 0 && deps.onInbound) {
        try {
          deps.onInbound({ count: drained.dispatched });
        } catch {
          /* never let a UI notification break the loop */
        }
      }
      const t = now();
      if (t - lastPresenceAt >= presenceMs) {
        await service.heartbeat();
        lastPresenceAt = t;
      }
    } catch (err) {
      log.debug(`circles fast cycle failed: ${String(err)}`);
    } finally {
      schedule(nextMs);
    }
  };

  // Kick off immediately.
  void cycle();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
