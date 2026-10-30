import { describe, expect, it } from "vitest";
import {
  bm25RankToScore,
  boundPostFusionBoost,
  buildFtsQuery,
  mergeHybridResults,
  mergeHybridResultsRRF,
} from "./hybrid.js";
import { rrfFuse } from "./rrf.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and OR-joins so bm25 ranks by how many terms match", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" OR "baz" OR "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" OR "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("boundPostFusionBoost shrinks a multiplicative boost toward the fused score's scale", () => {
    const base = 2 / 61; // rank 1 in two channels under RRF k=60
    expect(boundPostFusionBoost(base, base * 1.5, 1)).toBeCloseTo(base * 1.5, 12);
    expect(boundPostFusionBoost(base, base * 1.5, 0.1)).toBeCloseTo(base * 1.05, 12);
    expect(boundPostFusionBoost(base, base * 0.0625, 0.1)).toBeCloseTo(base * 0.90625, 12);
    expect(boundPostFusionBoost(base, base * 0.0625, 0)).toBeCloseTo(base, 12);
    // Degenerate inputs pass the boosted value through untouched.
    expect(boundPostFusionBoost(0, 0.5, 0.1)).toBe(0.5);
    expect(boundPostFusionBoost(base, Number.NaN, 0.1)).toBeNaN();
  });

  it("buildFtsQuery drops stopwords from a sentence but keeps every word of a short lookup", () => {
    // A natural question: under AND this matched nothing anywhere.
    expect(buildFtsQuery("what did the user say about their trip to Paris")).toBe(
      '"user" OR "say" OR "trip" OR "Paris"',
    );
    // Two tokens: no stopword pass, so "the" survives on purpose.
    expect(buildFtsQuery("the matrix")).toBe('"the" OR "matrix"');
    // All stopwords: fall back to the raw tokens rather than returning nothing.
    expect(buildFtsQuery("and the for")).toBe('"and" OR "the" OR "for"');
    // Duplicates collapse and the term list is capped.
    expect(buildFtsQuery("alpha alpha beta")).toBe('"alpha" OR "beta"');
    expect(
      buildFtsQuery(Array.from({ length: 30 }, (_, i) => `term${i}`).join(" "))?.split(" OR "),
    ).toHaveLength(16);
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1);
  });

  it("mergeHybridResults unions by id and combines weighted scores", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
  });

  it("mergeHybridResults carries per-channel ranks and native scores (PLAN-58)", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "a.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "",
          vectorScore: 0.9,
        },
        {
          id: "b",
          path: "b.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "",
          vectorScore: 0.4,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "b.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "kw",
          textScore: 1.0,
        },
      ],
    });
    const a = merged.find((r) => r.path === "a.md")!;
    const b = merged.find((r) => r.path === "b.md")!;
    expect(a.fusion).toBe("weighted");
    expect(a.channels).toEqual({ vector: { rank: 1, score: 0.9 } });
    expect(b.channels).toEqual({
      vector: { rank: 2, score: 0.4 },
      keyword: { rank: 1, score: 1.0 },
    });
  });
});

describe("mergeHybridResultsRRF (PLAN-58 channel diagnostics)", () => {
  const vec = (id: string, vectorScore: number) => ({
    id,
    path: `${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: `vec-${id}`,
    vectorScore,
  });
  const kw = (id: string, textScore: number) => ({
    id,
    path: `${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: `kw-${id}`,
    textScore,
  });
  const gr = (id: string, graphScore: number) => ({
    id,
    path: `${id}.md`,
    startLine: 1,
    endLine: 2,
    source: "memory",
    snippet: `gr-${id}`,
    graphScore,
  });

  it("carries each channel's 1-based rank and native score for overlapping and single-channel ids", () => {
    const merged = mergeHybridResultsRRF({
      vector: [vec("a", 0.91), vec("b", 0.55), vec("c", 0.2)],
      keyword: [kw("b", 1.0), kw("d", 0.5)],
      graph: [gr("a", 0.7)],
    });
    const byId = new Map(merged.map((r) => [r.id, r]));
    expect(byId.get("a")?.fusion).toBe("rrf");
    expect(byId.get("a")?.channels).toEqual({
      vector: { rank: 1, score: 0.91 },
      graph: { rank: 1, score: 0.7 },
    });
    expect(byId.get("b")?.channels).toEqual({
      vector: { rank: 2, score: 0.55 },
      keyword: { rank: 1, score: 1.0 },
    });
    expect(byId.get("c")?.channels).toEqual({ vector: { rank: 3, score: 0.2 } });
    expect(byId.get("d")?.channels).toEqual({ keyword: { rank: 2, score: 0.5 } });
    // A channel that did not return the id is absent, never zero-filled.
    expect(byId.get("c")?.channels?.keyword).toBeUndefined();
    expect(byId.get("d")?.channels?.vector).toBeUndefined();
  });

  it("agrees with rrfFuse on ranks and leaves the fused score untouched", () => {
    const vector = [vec("a", 0.9), vec("b", 0.8)];
    const keyword = [kw("b", 1.0), kw("a", 0.3)];
    const merged = mergeHybridResultsRRF({ vector, keyword });
    const direct = rrfFuse([
      { name: "vector", entries: vector.map((r, i) => ({ id: r.id, rank: i + 1, payload: {} })) },
      { name: "keyword", entries: keyword.map((r, i) => ({ id: r.id, rank: i + 1, payload: {} })) },
    ]);
    for (const d of direct) {
      const m = merged.find((r) => r.id === d.id)!;
      expect(m.score).toBeCloseTo(d.score, 12);
      expect(m.channels?.vector?.rank).toBe(d.sourceRanks.vector);
      expect(m.channels?.keyword?.rank).toBe(d.sourceRanks.keyword);
    }
  });

  it("ranks by native score order, not input order", () => {
    const merged = mergeHybridResultsRRF({
      vector: [vec("low", 0.1), vec("high", 0.95)],
      keyword: [],
    });
    expect(merged.find((r) => r.id === "high")?.channels?.vector?.rank).toBe(1);
    expect(merged.find((r) => r.id === "low")?.channels?.vector?.rank).toBe(2);
  });

  it("applies per-channel weights and k, and 1/1/1 at 60 is the unweighted order", () => {
    const vector = [vec("a", 0.9), vec("b", 0.8), vec("c", 0.7)];
    const keyword = [kw("c", 1.0), kw("d", 0.9), kw("b", 0.5)];
    const graph = [gr("b", 0.9)];
    const plain = mergeHybridResultsRRF({ vector, keyword, graph });
    const explicit = mergeHybridResultsRRF({
      vector,
      keyword,
      graph,
      weights: { vector: 1, keyword: 1, graph: 1 },
      k: 60,
    });
    expect(explicit).toEqual(plain);
    expect(plain.map((r) => r.id)).toEqual(["b", "c", "a", "d"]);

    const keywordHeavy = mergeHybridResultsRRF({
      vector,
      keyword,
      graph,
      weights: { vector: 0.1 },
    });
    // "a" (vector rank 1 only) drops behind "d" (keyword rank 2 only).
    expect(keywordHeavy.map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    const b = keywordHeavy.find((r) => r.id === "b")!;
    expect(b.score).toBeCloseTo(0.1 / 62 + 1 / 63 + 1 / 61, 12);
    // channel diagnostics are unaffected by the weights
    expect(b.channels).toEqual({
      vector: { rank: 2, score: 0.8 },
      keyword: { rank: 3, score: 0.5 },
      graph: { rank: 1, score: 0.9 },
    });
    // a smaller k sharpens the top ranks: "d" (keyword 2) overtakes "c"? No:
    // c holds keyword 1, so c stays ahead; what moves is the gap, which the
    // scores show (ratio c/d grows as k shrinks).
    const sharp = mergeHybridResultsRRF({ vector, keyword, graph, weights: { vector: 0.1 }, k: 5 });
    const ratio = (list: typeof sharp) =>
      list.find((r) => r.id === "c")!.score / list.find((r) => r.id === "d")!.score;
    expect(ratio(sharp)).toBeGreaterThan(ratio(keywordHeavy));
  });

  it("weight 0 silences a channel: vector-only ids vanish, the rest match a two-channel merge", () => {
    const vector = [vec("a", 0.9), vec("solo", 0.85), vec("b", 0.8)];
    const keyword = [kw("c", 1.0), kw("b", 0.5)];
    const twoChannel = mergeHybridResultsRRF({ vector: [], keyword });
    const silenced = mergeHybridResultsRRF({ vector, keyword, weights: { vector: 0 } });
    expect(silenced.map((r) => r.id)).toEqual(twoChannel.map((r) => r.id));
    expect(silenced.map((r) => r.score)).toEqual(twoChannel.map((r) => r.score));
    expect(silenced.find((r) => r.id === "solo")).toBeUndefined();
    // the silenced channel's rank is still reported on the ids it shares
    expect(silenced.find((r) => r.id === "b")?.channels?.vector).toEqual({ rank: 3, score: 0.8 });
  });

  it("keeps the fused RRF score on its own scale (below 0.05 even for triple consensus)", () => {
    const merged = mergeHybridResultsRRF({
      vector: [vec("a", 0.99)],
      keyword: [kw("a", 1.0)],
      graph: [gr("a", 1.0)],
    });
    expect(merged[0]?.score).toBeLessThan(0.05);
    expect(merged[0]?.channels?.vector?.score).toBe(0.99);
  });
});
