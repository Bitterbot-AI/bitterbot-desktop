import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  fetchTrendingCandidates,
  looksLikeScrapableSource,
  runTrendingSweep,
  trendingSinceDate,
  type TrendingAdapter,
} from "./skill-seekers-trending.js";

describe("skill-seekers-trending", () => {
  describe("trendingSinceDate", () => {
    it("returns ISO date 1 day back for daily", () => {
      const now = Date.UTC(2026, 3, 15, 12, 0, 0); // 2026-04-15
      expect(trendingSinceDate("daily", now)).toBe("2026-04-14");
    });

    it("returns ISO date 7 days back for weekly", () => {
      const now = Date.UTC(2026, 3, 15, 12, 0, 0);
      expect(trendingSinceDate("weekly", now)).toBe("2026-04-08");
    });

    it("returns ISO date 1 month back for monthly", () => {
      const now = Date.UTC(2026, 3, 15, 12, 0, 0);
      expect(trendingSinceDate("monthly", now)).toBe("2026-03-15");
    });
  });

  describe("looksLikeScrapableSource", () => {
    it("accepts docs and blog-like URLs", () => {
      expect(looksLikeScrapableSource("https://docs.python.org/3/")).toBe(true);
      expect(looksLikeScrapableSource("https://someblog.com/post/42")).toBe(true);
    });

    it("accepts github.com repos", () => {
      expect(looksLikeScrapableSource("https://github.com/facebook/react")).toBe(true);
    });

    it("rejects short-form / media / aggregator hosts", () => {
      expect(looksLikeScrapableSource("https://twitter.com/user/status/1")).toBe(false);
      expect(looksLikeScrapableSource("https://x.com/user/status/1")).toBe(false);
      expect(looksLikeScrapableSource("https://www.youtube.com/watch?v=x")).toBe(false);
      expect(looksLikeScrapableSource("https://reddit.com/r/programming")).toBe(false);
      expect(looksLikeScrapableSource("https://news.ycombinator.com/item?id=1")).toBe(false);
    });

    it("rejects PDF and Jupyter extensions", () => {
      expect(looksLikeScrapableSource("https://example.com/paper.pdf")).toBe(false);
      expect(looksLikeScrapableSource("https://example.com/notebook.ipynb")).toBe(false);
    });

    it("rejects malformed URLs", () => {
      expect(looksLikeScrapableSource("not a url")).toBe(false);
    });
  });

  describe("fetchTrendingCandidates — curated", () => {
    it("returns the curated URLs with high scores", async () => {
      const candidates = await fetchTrendingCandidates([
        {
          kind: "curated",
          urls: ["https://docs.python.org/3/", "https://github.com/torvalds/linux"],
        },
      ]);
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.source).toBe("curated");
      expect(candidates[0]?.score).toBeGreaterThan(candidates[1]?.score ?? 0);
    });

    it("honors the per-source limit", async () => {
      const candidates = await fetchTrendingCandidates([
        {
          kind: "curated",
          urls: ["https://a.example.com", "https://b.example.com", "https://c.example.com"],
          limit: 2,
        },
      ]);
      expect(candidates).toHaveLength(2);
    });
  });

  describe("runTrendingSweep", () => {
    const originalFetch = globalThis.fetch;
    beforeEach(() => {
      // No-op default fetch — sources that need it return empty.
      globalThis.fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("dedups against alreadyScrapedUrls", async () => {
      const ingestBatch = vi.fn(async (sources: unknown[]) => ({
        total: sources.length,
        succeeded: sources.length,
        failed: 0,
        results: [],
      }));
      const adapter: TrendingAdapter = {
        budgetRemaining: () => 10,
        ingestBatch,
      };
      const result = await runTrendingSweep(
        adapter,
        [
          {
            kind: "curated",
            urls: ["https://a.example.com", "https://b.example.com"],
          },
        ],
        { alreadyScrapedUrls: new Set(["https://a.example.com"]) },
      );
      expect(result.scraped).toBe(1);
      expect(ingestBatch).toHaveBeenCalledWith([
        expect.objectContaining({ url: "https://b.example.com" }),
      ]);
    });

    it("respects the adapter's remaining budget", async () => {
      const adapter: TrendingAdapter = {
        budgetRemaining: () => 1,
        ingestBatch: vi.fn(async (sources) => ({
          total: sources.length,
          succeeded: sources.length,
          failed: 0,
          results: [],
        })),
      };
      const result = await runTrendingSweep(
        adapter,
        [
          {
            kind: "curated",
            urls: ["https://a.example.com", "https://b.example.com", "https://c.example.com"],
          },
        ],
        { maxPerSweep: 10 },
      );
      // Budget=1 caps the batch.
      expect(result.scraped).toBe(1);
    });

    it("respects maxPerSweep even when budget is larger", async () => {
      const adapter: TrendingAdapter = {
        budgetRemaining: () => 10,
        ingestBatch: vi.fn(async (sources) => ({
          total: sources.length,
          succeeded: sources.length,
          failed: 0,
          results: [],
        })),
      };
      const result = await runTrendingSweep(
        adapter,
        [
          {
            kind: "curated",
            urls: [
              "https://a.example.com",
              "https://b.example.com",
              "https://c.example.com",
              "https://d.example.com",
            ],
          },
        ],
        { maxPerSweep: 2 },
      );
      expect(result.scraped).toBe(2);
    });

    it("returns zero scraped when budget is zero", async () => {
      const ingestBatch = vi.fn(async () => ({
        total: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      }));
      const adapter: TrendingAdapter = {
        budgetRemaining: () => 0,
        ingestBatch,
      };
      const result = await runTrendingSweep(adapter, [
        { kind: "curated", urls: ["https://a.example.com"] },
      ]);
      expect(result.scraped).toBe(0);
      expect(ingestBatch).not.toHaveBeenCalled();
    });
  });
});
