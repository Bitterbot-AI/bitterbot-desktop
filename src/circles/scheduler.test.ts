import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCirclesScheduler, type SchedulableCirclesService } from "./scheduler.js";

// PLAN-36 Phase 0: the fast circles loop. Fake timers + a stub service so we
// assert cadence, presence throttle, idle-backoff, the enabled gate, and stop()
// without any DB or network.

function stubService(overrides: Partial<SchedulableCirclesService> = {}) {
  const calls = { poll: 0, heartbeat: 0, hasActive: 0 };
  const svc: SchedulableCirclesService = {
    hasActiveCircles: () => {
      calls.hasActive += 1;
      return true;
    },
    pollMailbox: async () => {
      calls.poll += 1;
      return { received: 0, dispatched: 0 };
    },
    heartbeat: async () => {
      calls.heartbeat += 1;
    },
    ...overrides,
  };
  return { svc, calls };
}

describe("startCirclesScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("drains the mailbox once immediately on start (no 30-min wait)", async () => {
    const { svc, calls } = stubService();
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.poll).toBe(1);
    expect(calls.heartbeat).toBe(1); // first cycle also beats (lastPresenceAt=0)
    h.stop();
  });

  it("polls on the fast cadence but throttles presence to its sub-cadence", async () => {
    const { svc, calls } = stubService();
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
      presenceIntervalMs: 3_000,
    });
    // Run ~7 cycles (t=0,1,2,...6s).
    await vi.advanceTimersByTimeAsync(6_500);
    // ~7 polls, but presence only every 3s: t=0, 3s, 6s -> 3 beats.
    expect(calls.poll).toBeGreaterThanOrEqual(6);
    expect(calls.heartbeat).toBe(3);
    h.stop();
  });

  it("idles (slow interval) when circles are disabled and never touches the service", async () => {
    const { svc, calls } = stubService();
    let enabled = false;
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
      idleIntervalMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.poll).toBe(0); // never polled while disabled
    // Flip on: next idle cycle (at 10s) picks it up and starts fast-polling.
    enabled = true;
    await vi.advanceTimersByTimeAsync(6_000); // reach the 10s idle reschedule
    expect(calls.poll).toBeGreaterThanOrEqual(1);
    h.stop();
  });

  it("idles when the node has no active (non-practice) circle", async () => {
    const { svc, calls } = stubService({ hasActiveCircles: () => false });
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
      idleIntervalMs: 10_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.poll).toBe(0); // active-check gated it before any poll
    h.stop();
  });

  it("survives a throwing cycle and keeps rescheduling", async () => {
    let throws = 2;
    const { svc, calls } = stubService({
      pollMailbox: async () => {
        if (throws-- > 0) throw new Error("boom");
        calls.poll += 1;
        return { received: 0, dispatched: 0 };
      },
    });
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls.poll).toBeGreaterThanOrEqual(1); // recovered after 2 throws
    h.stop();
  });

  it("fires onInbound when a drain delivers messages, and not when it delivers none", async () => {
    let dispatched = 2;
    const { svc } = stubService({
      pollMailbox: async () => ({ received: dispatched, dispatched }),
    });
    const seen: Array<{ count: number }> = [];
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
      onInbound: (info) => seen.push(info),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ count: 2 }]);
    // Next drain delivers nothing -> no further onInbound.
    dispatched = 0;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen).toEqual([{ count: 2 }]);
    h.stop();
  });

  it("stop() cancels the pending timer (no further cycles)", async () => {
    const { svc, calls } = stubService();
    const h = startCirclesScheduler({
      getConfig: () => ({ circles: { enabled: true } }),
      resolveService: async () => svc,
      pollIntervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    const pollsAtStop = calls.poll;
    h.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.poll).toBe(pollsAtStop);
  });
});
