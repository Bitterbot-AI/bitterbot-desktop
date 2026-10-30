import { describe, expect, it } from "vitest";
import { rrfFuse } from "./rrf.js";

const entry = (id: string, rank: number) => ({ id, rank, payload: { id } });

describe("rrfFuse", () => {
  it("returns nothing for no lists", () => {
    expect(rrfFuse([])).toEqual([]);
  });

  it("scores one list as 1/(k+rank) and records the rank under the list name", () => {
    const fused = rrfFuse([{ name: "vector", entries: [entry("a", 1), entry("b", 2)] }]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61);
    expect(fused[1]?.score).toBeCloseTo(1 / 62);
    expect(fused[0]?.sourceRanks).toEqual({ vector: 1 });
    expect(fused[1]?.sourceRanks).toEqual({ vector: 2 });
  });

  it("sums contributions across lists and keeps every list's rank (consensus wins)", () => {
    const fused = rrfFuse([
      { name: "vector", entries: [entry("a", 1), entry("b", 2)] },
      { name: "keyword", entries: [entry("b", 1), entry("c", 2)] },
      { name: "graph", entries: [entry("b", 3)] },
    ]);
    const b = fused.find((f) => f.id === "b");
    expect(fused[0]?.id).toBe("b");
    expect(b?.score).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 63);
    expect(b?.sourceRanks).toEqual({ vector: 2, keyword: 1, graph: 3 });
    expect(fused.find((f) => f.id === "a")?.sourceRanks).toEqual({ vector: 1 });
    expect(fused.find((f) => f.id === "c")?.sourceRanks).toEqual({ keyword: 2 });
  });

  it("caps the fused score near lists/(k+1), far below a cosine scale", () => {
    const fused = rrfFuse([
      { name: "vector", entries: [entry("a", 1)] },
      { name: "keyword", entries: [entry("a", 1)] },
      { name: "graph", entries: [entry("a", 1)] },
    ]);
    expect(fused[0]?.score).toBeCloseTo(3 / 61);
    expect(fused[0]!.score).toBeLessThan(0.05);
  });

  it("honours a custom k", () => {
    const fused = rrfFuse([{ name: "vector", entries: [entry("a", 1)] }], 10);
    expect(fused[0]?.score).toBeCloseTo(1 / 11);
  });
});

describe("rrfFuse weights", () => {
  // Three channels, overlapping ids, deliberately chosen so unweighted RRF,
  // vector-light RRF and a small k each produce a different order.
  const vector = { name: "vector", entries: [entry("a", 1), entry("b", 2), entry("c", 3)] };
  const keyword = { name: "keyword", entries: [entry("c", 1), entry("d", 2), entry("b", 3)] };
  const graph = { name: "graph", entries: [entry("b", 1)] };
  const order = (lists: Parameters<typeof rrfFuse>[0], k?: number) =>
    rrfFuse(lists, k).map((f) => f.id);

  it("explicit weights 1/1/1 at k 60 reproduce the unweighted fusion exactly", () => {
    const unweighted = rrfFuse([vector, keyword, graph]);
    const weighted = rrfFuse(
      [
        { ...vector, weight: 1 },
        { ...keyword, weight: 1 },
        { ...graph, weight: 1 },
      ],
      60,
    );
    expect(weighted).toEqual(unweighted);
    // and the fixture's order under plain RRF, pinned so a change is visible
    expect(unweighted.map((f) => f.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("scales a list's contribution by its weight", () => {
    const fused = rrfFuse([{ ...vector, weight: 0.1 }, keyword]);
    const b = fused.find((f) => f.id === "b");
    expect(b?.score).toBeCloseTo(0.1 / 62 + 1 / 63, 12);
    expect(b?.sourceRanks).toEqual({ vector: 2, keyword: 3 });
  });

  it("down-weighting the vector channel changes the order toward the keyword list", () => {
    // "a" (vector rank 1 only) falls behind "d" (keyword rank 2 only).
    expect(order([{ ...vector, weight: 0.1 }, keyword, graph])).toEqual(["b", "c", "d", "a"]);
  });

  it("weight 0 removes a channel: same order as leaving the list out, its only-ids dropped", () => {
    const withoutVector = rrfFuse([keyword, graph]);
    const zeroVector = rrfFuse([{ ...vector, weight: 0 }, keyword, graph]);
    expect(zeroVector.map((f) => f.id)).toEqual(["b", "c", "d"]);
    expect(zeroVector.map((f) => f.id)).toEqual(withoutVector.map((f) => f.id));
    expect(zeroVector.map((f) => f.score)).toEqual(withoutVector.map((f) => f.score));
    // "a" was found only by the vector channel and is gone; "b" survives
    // through keyword and graph and still reports its vector rank.
    expect(zeroVector.find((f) => f.id === "a")).toBeUndefined();
    expect(zeroVector.find((f) => f.id === "b")?.sourceRanks).toEqual({
      vector: 2,
      keyword: 3,
      graph: 1,
    });
    const onlyVector = rrfFuse([{ name: "vector", entries: [entry("solo", 1)], weight: 0 }]);
    expect(onlyVector).toEqual([]);
  });

  it("k changes the ordering: a small k rewards a single top rank over two middling ones", () => {
    // "b" sits at 2 and 3 in two lists; "e" is first in one list only.
    const lists = [
      { name: "vector", entries: [entry("e", 1), entry("b", 2)] },
      { name: "keyword", entries: [entry("x", 1), entry("y", 2), entry("b", 3)] },
    ];
    // Equal weights: two appearances beat one at any k (1/62 + 1/63 > 1/61).
    expect(order(lists, 60)).toEqual(["b", "e", "x", "y"]);
    expect(order(lists, 1)).toEqual(["b", "e", "x", "y"]);
    // With the keyword list down-weighted, k decides: at k 60 "b" still wins
    // (1/62 + 0.1/63 > 1/61), at k 1 the single top rank wins (1/2 > 1/3 + 0.1/4).
    const heavy = [
      { ...lists[0]!, weight: 1 },
      { ...lists[1]!, weight: 0.1 },
    ];
    expect(order(heavy, 60)).toEqual(["b", "e", "x", "y"]);
    expect(order(heavy, 1)).toEqual(["e", "b", "x", "y"]);
  });

  it("treats a negative or non-finite weight as 1 and a non-positive or non-finite k as 60", () => {
    const base = rrfFuse([vector, keyword]);
    expect(rrfFuse([{ ...vector, weight: -1 }, keyword])).toEqual(base);
    expect(rrfFuse([{ ...vector, weight: Number.NaN }, keyword])).toEqual(base);
    expect(rrfFuse([{ ...vector, weight: Number.POSITIVE_INFINITY }, keyword])).toEqual(base);
    expect(rrfFuse([vector, keyword], 0)).toEqual(base);
    expect(rrfFuse([vector, keyword], -5)).toEqual(base);
    expect(rrfFuse([vector, keyword], Number.NaN)).toEqual(base);
  });
});
