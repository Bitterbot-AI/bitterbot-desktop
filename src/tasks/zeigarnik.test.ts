import { describe, expect, it } from "vitest";
import {
  computeZeigarnikTension,
  maybeResumeFromTension,
  type ZeigarnikTask,
  type ZeigarnikTension,
} from "./zeigarnik.js";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function task(over: Partial<ZeigarnikTask> = {}): ZeigarnikTask {
  return { status: "pending", createdAt: NOW - HOUR, lastSeenAt: NOW - HOUR, ...over };
}

describe("computeZeigarnikTension", () => {
  it("is zero when there are no tasks", () => {
    const t = computeZeigarnikTension({ tasks: [], now: NOW });
    expect(t.tension).toBe(0);
    expect(t.pendingCount).toBe(0);
  });

  it("ignores terminal tasks", () => {
    const t = computeZeigarnikTension({
      tasks: [
        task({ status: "completed" }),
        task({ status: "failed" }),
        task({ status: "stopped" }),
      ],
      now: NOW,
    });
    expect(t.pendingCount).toBe(0);
    expect(t.tension).toBe(0);
  });

  it("rises with the number of open tasks", () => {
    const few = computeZeigarnikTension({ tasks: [task()], now: NOW });
    const many = computeZeigarnikTension({ tasks: [task(), task(), task(), task()], now: NOW });
    expect(many.tension).toBeGreaterThan(few.tension);
    expect(many.pendingCount).toBe(4);
  });

  it("rises with age and stall", () => {
    const fresh = computeZeigarnikTension({
      tasks: [task({ createdAt: NOW - HOUR, lastSeenAt: NOW - HOUR })],
      now: NOW,
    });
    const stale = computeZeigarnikTension({
      tasks: [task({ createdAt: NOW - DAY, lastSeenAt: NOW - 12 * HOUR })],
      now: NOW,
    });
    expect(stale.tension).toBeGreaterThan(fresh.tension);
    expect(stale.oldestAgeMs).toBe(DAY);
  });

  it("stays within [0,1] even when saturated", () => {
    const tasks = Array.from({ length: 20 }, () =>
      task({ createdAt: NOW - 10 * DAY, lastSeenAt: NOW - 10 * DAY }),
    );
    const t = computeZeigarnikTension({ tasks, now: NOW, hormonal: { cortisol: 1 } });
    expect(t.tension).toBeGreaterThan(0);
    expect(t.tension).toBeLessThanOrEqual(1);
  });

  it("cortisol amplifies and dopamine dampens tension", () => {
    const base = computeZeigarnikTension({ tasks: [task(), task()], now: NOW });
    const stressed = computeZeigarnikTension({
      tasks: [task(), task()],
      now: NOW,
      hormonal: { cortisol: 1 },
    });
    const driven = computeZeigarnikTension({
      tasks: [task(), task()],
      now: NOW,
      hormonal: { dopamine: 1 },
    });
    expect(stressed.tension).toBeGreaterThan(base.tension);
    expect(driven.tension).toBeLessThan(base.tension);
  });
});

describe("maybeResumeFromTension", () => {
  const high: ZeigarnikTension = {
    tension: 0.8,
    pendingCount: 3,
    oldestAgeMs: DAY,
    maxStallMs: 12 * HOUR,
    contributors: [],
  };
  const low: ZeigarnikTension = { ...high, tension: 0.2 };

  it("resumes when tension is above threshold and not throttled", () => {
    const d = maybeResumeFromTension({ tension: high, now: NOW });
    expect(d.resume).toBe(true);
  });

  it("does not resume below threshold", () => {
    const d = maybeResumeFromTension({ tension: low, now: NOW });
    expect(d.resume).toBe(false);
    expect(d.reason).toMatch(/below/);
  });

  it("respects the throttle window", () => {
    const d = maybeResumeFromTension({ tension: high, now: NOW, lastResumeAt: NOW - 60_000 });
    expect(d.resume).toBe(false);
    expect(d.reason).toMatch(/throttled/);
  });

  it("resumes once the throttle window has elapsed", () => {
    const d = maybeResumeFromTension({ tension: high, now: NOW, lastResumeAt: NOW - 10 * 60_000 });
    expect(d.resume).toBe(true);
  });

  it("decays (does not resume) when dismissed", () => {
    const d = maybeResumeFromTension({ tension: high, now: NOW, dismissed: true });
    expect(d.resume).toBe(false);
    expect(d.reason).toMatch(/dismissed/);
  });

  it("does not resume when there are no open tasks", () => {
    const none: ZeigarnikTension = { ...high, pendingCount: 0, tension: 0 };
    const d = maybeResumeFromTension({ tension: none, now: NOW });
    expect(d.resume).toBe(false);
  });
});
