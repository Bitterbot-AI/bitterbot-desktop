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
