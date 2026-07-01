import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttl-cache.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TtlCache", () => {
  it("returns undefined for a missing key", () => {
    const cache = new TtlCache<number>(1000);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("returns a cached value within the TTL window", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    vi.advanceTimersByTime(999);
    expect(cache.get("k")).toBe("v");
  });

  it("expires a value once the TTL elapses", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");
    vi.advanceTimersByTime(1000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("keeps distinct keys independent", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("clear() drops everything", () => {
    const cache = new TtlCache<number>(1000);
    cache.set("a", 1);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });

  describe("getOrCompute (single-flight)", () => {
    it("coalesces concurrent misses into a single computation", async () => {
      const cache = new TtlCache<number>(1000);
      let calls = 0;
      const compute = () => {
        calls += 1;
        return Promise.resolve(42);
      };
      const results = await Promise.all([
        cache.getOrCompute("k", compute),
        cache.getOrCompute("k", compute),
        cache.getOrCompute("k", compute),
      ]);
      expect(results).toEqual([42, 42, 42]);
      // The whole point: a burst of concurrent misses runs compute once.
      expect(calls).toBe(1);
    });

    it("caches the resolved value for the TTL and serves it without recomputing", async () => {
      const cache = new TtlCache<number>(1000);
      let calls = 0;
      const compute = () => {
        calls += 1;
        return Promise.resolve(7);
      };
      expect(await cache.getOrCompute("k", compute)).toBe(7);
      expect(await cache.getOrCompute("k", compute)).toBe(7);
      expect(calls).toBe(1);
      expect(cache.get("k")).toBe(7);
    });

    it("recomputes after the TTL expires", async () => {
      const cache = new TtlCache<number>(1000);
      let n = 0;
      const compute = () => {
        n += 1;
        return Promise.resolve(n);
      };
      expect(await cache.getOrCompute("k", compute)).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(await cache.getOrCompute("k", compute)).toBe(2);
    });

    it("does not cache a rejected computation and retries on the next call", async () => {
      const cache = new TtlCache<number>(1000);
      let calls = 0;
      const compute = () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(99);
      };
      await expect(cache.getOrCompute("k", compute)).rejects.toThrow("boom");
      // In-flight entry cleared on rejection, so the retry recomputes.
      expect(await cache.getOrCompute("k", compute)).toBe(99);
      expect(calls).toBe(2);
    });
  });
});
