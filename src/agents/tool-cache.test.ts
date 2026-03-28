import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCache, getGlobalToolCache, setGlobalToolCache } from "./tool-cache.js";

describe("ToolCache", () => {
  let cache: ToolCache;

  beforeEach(() => {
    cache = new ToolCache({ maxEntries: 5, defaultTtlMs: 1000 });
  });

  describe("generateKey", () => {
    it("produces deterministic keys for same tool + args", () => {
      const a = cache.generateKey("read", { path: "/foo" });
      const b = cache.generateKey("read", { path: "/foo" });
      expect(a).toBe(b);
    });

    it("produces different keys for different args", () => {
      const a = cache.generateKey("read", { path: "/foo" });
      const b = cache.generateKey("read", { path: "/bar" });
      expect(a).not.toBe(b);
    });

    it("produces different keys for different tool names", () => {
      const a = cache.generateKey("read", { path: "/foo" });
      const b = cache.generateKey("web_fetch", { path: "/foo" });
      expect(a).not.toBe(b);
    });

    it("sorts args keys for deterministic hashing", () => {
      const a = cache.generateKey("read", { path: "/foo", limit: 100 });
      const b = cache.generateKey("read", { limit: 100, path: "/foo" });
      expect(a).toBe(b);
    });
  });

  describe("get/set", () => {
    it("returns undefined on cache miss", () => {
      expect(cache.get("read", { path: "/foo" })).toBeUndefined();
    });

    it("returns cached result on hit", () => {
      const result = { content: [{ type: "text", text: "hello" }] };
      cache.set("read", { path: "/foo" }, result);
      expect(cache.get("read", { path: "/foo" })).toEqual(result);
    });

    it("returns undefined after TTL expiry", () => {
      vi.useFakeTimers();
      cache.set("read", { path: "/foo" }, "result", 500);
      expect(cache.get("read", { path: "/foo" })).toBe("result");
      vi.advanceTimersByTime(600);
      expect(cache.get("read", { path: "/foo" })).toBeUndefined();
      vi.useRealTimers();
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when at capacity", () => {
      for (let i = 0; i < 5; i++) {
        cache.set("read", { path: `/file${i}` }, `result${i}`);
      }
      // Cache is full (5 entries). Adding one more should evict the oldest.
      cache.set("read", { path: "/file5" }, "result5");
      // Oldest (/file0) should be evicted
      expect(cache.get("read", { path: "/file0" })).toBeUndefined();
      // Newest should still be there
      expect(cache.get("read", { path: "/file5" })).toBe("result5");
    });

    it("refreshes entry position on get (LRU)", () => {
      cache.set("read", { path: "/a" }, "a");
      cache.set("read", { path: "/b" }, "b");
      cache.set("read", { path: "/c" }, "c");
      cache.set("read", { path: "/d" }, "d");
      cache.set("read", { path: "/e" }, "e");
      // Access /a to move it to end (most recently used)
      cache.get("read", { path: "/a" });
      // Now add a new entry — /b should be evicted (oldest untouched)
      cache.set("read", { path: "/f" }, "f");
      expect(cache.get("read", { path: "/b" })).toBeUndefined();
      expect(cache.get("read", { path: "/a" })).toBe("a");
    });
  });

  describe("invalidate", () => {
    it("invalidates a specific entry", () => {
      cache.set("read", { path: "/foo" }, "result");
      cache.invalidate("read", { path: "/foo" });
      expect(cache.get("read", { path: "/foo" })).toBeUndefined();
    });

    it("invalidates all entries for a tool name", () => {
      cache.set("read", { path: "/a" }, "a");
      cache.set("read", { path: "/b" }, "b");
      cache.set("web_search", { query: "test" }, "search");
      cache.invalidate("read");
      expect(cache.get("read", { path: "/a" })).toBeUndefined();
      expect(cache.get("read", { path: "/b" })).toBeUndefined();
      expect(cache.get("web_search", { query: "test" })).toBe("search");
    });
  });

  describe("stats", () => {
    it("tracks hits and misses", () => {
      cache.set("read", { path: "/foo" }, "result");
      cache.get("read", { path: "/foo" }); // hit
      cache.get("read", { path: "/bar" }); // miss
      cache.get("read", { path: "/foo" }); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it("tracks evictions", () => {
      for (let i = 0; i < 6; i++) {
        cache.set("read", { path: `/file${i}` }, `result${i}`);
      }
      expect(cache.getStats().evictions).toBe(1);
    });

    it("reports size", () => {
      cache.set("read", { path: "/a" }, "a");
      cache.set("read", { path: "/b" }, "b");
      expect(cache.getStats().size).toBe(2);
    });
  });

  describe("isCacheable", () => {
    it("returns true for default cacheable tools", () => {
      const defaultCache = new ToolCache();
      expect(defaultCache.isCacheable("read")).toBe(true);
      expect(defaultCache.isCacheable("web_search")).toBe(true);
      expect(defaultCache.isCacheable("web_fetch")).toBe(true);
      expect(defaultCache.isCacheable("image")).toBe(true);
      expect(defaultCache.isCacheable("memory_search")).toBe(true);
    });

    it("returns false for non-cacheable tools", () => {
      const defaultCache = new ToolCache();
      expect(defaultCache.isCacheable("exec")).toBe(false);
      expect(defaultCache.isCacheable("write")).toBe(false);
      expect(defaultCache.isCacheable("edit")).toBe(false);
      expect(defaultCache.isCacheable("message")).toBe(false);
    });

    it("returns false when disabled", () => {
      const disabled = new ToolCache({ enabled: false });
      expect(disabled.isCacheable("read")).toBe(false);
    });

    it("respects custom cacheable tools list", () => {
      const custom = new ToolCache({ cacheableTools: ["my_tool"] });
      expect(custom.isCacheable("my_tool")).toBe(true);
      expect(custom.isCacheable("read")).toBe(false);
    });
  });

  describe("disabled cache", () => {
    it("get returns undefined when disabled", () => {
      const disabled = new ToolCache({ enabled: false });
      disabled.set("read", { path: "/foo" }, "result");
      expect(disabled.get("read", { path: "/foo" })).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all entries but preserves stats", () => {
      cache.set("read", { path: "/a" }, "a");
      cache.get("read", { path: "/a" });
      cache.clear();
      expect(cache.getStats().size).toBe(0);
      expect(cache.getStats().hits).toBe(1);
    });
  });
});

describe("getGlobalToolCache / setGlobalToolCache", () => {
  afterEach(() => {
    setGlobalToolCache(undefined);
  });

  it("returns the same instance on repeated calls", () => {
    const a = getGlobalToolCache();
    const b = getGlobalToolCache();
    expect(a).toBe(b);
  });

  it("can be replaced via setGlobalToolCache", () => {
    const original = getGlobalToolCache();
    const replacement = new ToolCache({ maxEntries: 10 });
    setGlobalToolCache(replacement);
    expect(getGlobalToolCache()).toBe(replacement);
    expect(getGlobalToolCache()).not.toBe(original);
  });
});
