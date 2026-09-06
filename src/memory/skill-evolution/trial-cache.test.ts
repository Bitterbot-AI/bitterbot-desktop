import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { TRIAL_CACHE_TTL_MS, TrialCache, trialCacheKey } from "./trial-cache.js";

const key = {
  taskId: "arith-basic",
  promptHash: "abc123",
  incumbentHash: "none",
  modelTag: "anthropic/claude-opus-4-8",
  generatorVersion: 4,
  trialIndex: 0,
};

describe("TrialCache (PLAN-44 Phase 2 incumbent memo)", () => {
  it("stores and returns incumbent trials by full key; any key change misses", () => {
    const cache = TrialCache.inMemory();
    expect(cache.get(key)).toBeNull();
    cache.put(key, { score: 1, answer: "FINAL: 42", skillRead: null });
    expect(cache.get(key)).toMatchObject({ score: 1, answer: "FINAL: 42", skillRead: null });
    expect(cache.get({ ...key, trialIndex: 1 })).toBeNull();
    expect(cache.get({ ...key, modelTag: "other/model" })).toBeNull();
    expect(cache.get({ ...key, promptHash: "def456" })).toBeNull();
    expect(cache.get({ ...key, generatorVersion: 5 })).toBeNull();
    expect(cache.get({ ...key, incumbentHash: "abc" })).toBeNull();
    expect(trialCacheKey(key)).toHaveLength(40);
    cache.close();
  });

  it("prunes rows older than the TTL on open", () => {
    const db = new DatabaseSync(":memory:");
    const now = 10_000_000_000;
    const c1 = new TrialCache(db, now);
    c1.put(key, { score: 0, answer: "old", skillRead: false }, now - TRIAL_CACHE_TTL_MS - 1);
    c1.put({ ...key, trialIndex: 9 }, { score: 1, answer: "fresh", skillRead: true }, now);
    expect(c1.size()).toBe(2);
    const c2 = new TrialCache(db, now);
    expect(c2.size()).toBe(1);
    expect(c2.get({ ...key, trialIndex: 9 })).toMatchObject({
      score: 1,
      answer: "fresh",
      skillRead: true,
    });
  });
});

describe("task_stats (PLAN-45 Phase 2.1 calibration)", () => {
  it("accumulates fractional incumbent passes per (task, model)", async () => {
    const { TrialCache } = await import("./trial-cache.js");
    const cache = TrialCache.inMemory();
    cache.recordIncumbentTaskStats("cap-a", "m1", 2, 3);
    cache.recordIncumbentTaskStats("cap-a", "m1", 1, 3);
    cache.recordIncumbentTaskStats("cap-a", "m2", 3, 3);
    cache.recordIncumbentTaskStats("cap-b", "m1", 0, 0); // ignored
    const m1 = cache.incumbentTaskStats("m1");
    expect(m1.get("cap-a")).toEqual({ trials: 6, passes: 3 });
    expect(m1.has("cap-b")).toBe(false);
    expect(cache.incumbentTaskStats("m2").get("cap-a")).toEqual({ trials: 3, passes: 3 });
    cache.close();
  });
});
