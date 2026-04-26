import { afterEach, describe, expect, it } from "vitest";
import {
  __cacheMonitorConsts,
  __resetCacheMonitorForTest,
  getCacheMetrics,
  listCacheMetrics,
  recordCacheTurn,
} from "./prompt-cache-monitor.js";

const KEY = "agent-a:s1";

afterEach(() => {
  __resetCacheMonitorForTest();
});

describe("prompt cache monitor — empty state", () => {
  it("returns null for unknown session", () => {
    expect(getCacheMetrics("does-not-exist")).toBeNull();
  });

  it("listCacheMetrics returns empty list initially", () => {
    expect(listCacheMetrics()).toEqual([]);
  });
});

describe("recordCacheTurn — first turn", () => {
  it("records a write-only first turn (no bust because no prior turn)", () => {
    const r = recordCacheTurn(KEY, { input: 100, cacheWrite: 2000, output: 50 });
    expect(r.bust).toBe(false);
    const m = getCacheMetrics(KEY)!;
    expect(m.turns).toBe(1);
    expect(m.busts).toBe(0);
    expect(m.cacheWrite).toBe(2000);
    expect(m.cacheRead).toBe(0);
    expect(m.hitRatio).toBeCloseTo(0, 5);
  });

  it("ignores turns with no cache traffic (provider didn't emit cache fields)", () => {
    const r = recordCacheTurn(KEY, { input: 0, output: 100 });
    expect(r.bust).toBe(false);
    expect(getCacheMetrics(KEY)).toBeNull();
  });
});

describe("hit ratio computation", () => {
  it("computes lifetime hit ratio from cumulative tokens", () => {
    recordCacheTurn(KEY, { input: 0, cacheRead: 1800, cacheWrite: 200 });
    recordCacheTurn(KEY, { input: 0, cacheRead: 1900, cacheWrite: 100 });
    const m = getCacheMetrics(KEY)!;
    // hits 3700 / total 4000 = 0.925
    expect(m.hitRatio).toBeCloseTo(3700 / 4000, 5);
  });

  it("recentHitRatio matches lifetime when within ring window", () => {
    for (let i = 0; i < 10; i++) {
      recordCacheTurn(KEY, { input: 0, cacheRead: 950, cacheWrite: 50 });
    }
    const m = getCacheMetrics(KEY)!;
    expect(m.hitRatio).toBeCloseTo(0.95, 5);
    expect(m.recentHitRatio).toBeCloseTo(0.95, 5);
  });

  it("ring drops oldest after RING_SIZE turns", () => {
    const big = __cacheMonitorConsts.RING_SIZE;
    for (let i = 0; i < big; i++) {
      recordCacheTurn(KEY, { input: 0, cacheRead: 100, cacheWrite: 0 });
    }
    // Now flood with poor-cache turns; ring rotates
    for (let i = 0; i < big; i++) {
      recordCacheTurn(KEY, { input: 1000, cacheRead: 0, cacheWrite: 1000 });
    }
    const m = getCacheMetrics(KEY)!;
    // recent window should reflect the second batch
    expect(m.recentHitRatio).toBeCloseTo(0, 2);
    // lifetime is mixed
    expect(m.hitRatio).toBeGreaterThan(0);
    expect(m.hitRatio).toBeLessThan(0.1);
  });
});

describe("bust detection", () => {
  it("flags a write where the previous turn was a read", () => {
    const r1 = recordCacheTurn(KEY, { input: 200, cacheRead: 1800, cacheWrite: 0 });
    expect(r1.bust).toBe(false);
    // Same input shape; cache no longer reads. This is the bust signal.
    const r2 = recordCacheTurn(KEY, { input: 200, cacheRead: 0, cacheWrite: 2000 });
    expect(r2.bust).toBe(true);
    expect(getCacheMetrics(KEY)!.busts).toBe(1);
  });

  it("does not flag a bust when input shape changed dramatically", () => {
    recordCacheTurn(KEY, { input: 200, cacheRead: 1800, cacheWrite: 0 });
    // Input 5x larger; cache write here is expected (longer prefix)
    const r2 = recordCacheTurn(KEY, { input: 1000, cacheRead: 0, cacheWrite: 5000 });
    expect(r2.bust).toBe(false);
  });

  it("does not flag a bust when this turn also has reads (cache still partly working)", () => {
    recordCacheTurn(KEY, { input: 200, cacheRead: 1800, cacheWrite: 0 });
    const r2 = recordCacheTurn(KEY, { input: 200, cacheRead: 1500, cacheWrite: 300 });
    expect(r2.bust).toBe(false);
  });
});

describe("multi-session isolation", () => {
  it("keeps metrics per session", () => {
    recordCacheTurn("s1", { input: 0, cacheRead: 1000, cacheWrite: 0 });
    recordCacheTurn("s2", { input: 0, cacheRead: 0, cacheWrite: 1000 });
    const a = getCacheMetrics("s1")!;
    const b = getCacheMetrics("s2")!;
    expect(a.cacheRead).toBe(1000);
    expect(a.cacheWrite).toBe(0);
    expect(b.cacheRead).toBe(0);
    expect(b.cacheWrite).toBe(1000);
    const list = listCacheMetrics().map((m) => m.sessionKey);
    expect(list.toSorted()).toEqual(["s1", "s2"]);
  });
});
