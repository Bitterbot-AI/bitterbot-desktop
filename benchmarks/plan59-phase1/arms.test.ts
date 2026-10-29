import { describe, expect, it } from "vitest";
import {
  buildArms,
  chooseK,
  selectPrioritised,
  selectRandom,
  selectRecency,
  shuffledBatch,
  ZERO_SELECTION_COST,
} from "./arms.js";
import type { PriorityRow } from "./estimate.js";
import type { Operation } from "./operations.js";

const op = (id: string, lastAccessedAt: number | null): Operation => ({
  kind: "bound_validity",
  id,
  factId: id,
  validUntil: 1,
  chunkIds: [`${id}-c`],
  families: [`fam-${id}`],
  lastAccessedAt,
});
const pool = [op("a", 5), op("b", null), op("c", 9), op("d", 9), op("e", 1), op("f", 3)];
const row = (opId: string, priority: number, need = 1): PriorityRow => ({
  opId,
  need,
  benefit: priority,
  cost: 1,
  priority,
  affectedQueries: 1,
  gain: {},
});

describe("arm selection", () => {
  it("picks K as 20 or the candidate count when fewer", () => {
    expect(chooseK(82)).toBe(20);
    expect(chooseK(7)).toBe(7);
    expect(chooseK(0)).toBe(0);
    expect(chooseK(50, 5)).toBe(5);
  });

  it("recency takes the most recently accessed first, ties by id, never-accessed last", () => {
    expect(selectRecency(pool, 4).map((o) => o.id)).toEqual(["c", "d", "a", "f"]);
    expect(selectRecency(pool, 6).map((o) => o.id)).toEqual(["c", "d", "a", "f", "e", "b"]);
  });

  it("random is uniform without replacement and reproducible under the seed", () => {
    const r1 = selectRandom(pool, 3, "59");
    const r2 = selectRandom(pool, 3, "59");
    expect(r1.map((o) => o.id)).toEqual(r2.map((o) => o.id));
    expect(new Set(r1.map((o) => o.id)).size).toBe(3);
    const r3 = selectRandom(pool, 6, "other");
    expect(r3.map((o) => o.id).toSorted()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(r3.map((o) => o.id)).not.toEqual(selectRandom(pool, 6, "59").map((o) => o.id));
  });

  it("prioritised orders by priority, then need, then id, with unestimated candidates last", () => {
    const rows = new Map([
      ["a", row("a", 0.5)],
      ["b", row("b", 0.9)],
      ["c", row("c", 0.5, 7)],
      ["d", row("d", 0)],
    ]);
    const needOf = (o: Operation) => (o.id === "e" ? 10 : 2);
    expect(selectPrioritised(pool, 6, rows, needOf).map((o) => o.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
      "e",
      "f",
    ]);
    expect(selectPrioritised(pool, 2, rows, needOf).map((o) => o.id)).toEqual(["b", "c"]);
  });

  it("shuffled batch is the same set in a seeded order", () => {
    const selected = selectRecency(pool, 6);
    const s1 = shuffledBatch(selected, "59");
    expect(s1.map((o) => o.id).toSorted()).toEqual(selected.map((o) => o.id).toSorted());
    expect(s1).toEqual(shuffledBatch(selected, "59"));
    expect(s1.map((o) => o.id)).not.toEqual(selected.map((o) => o.id));
  });

  it("buildArms gives every arm K operations, charges estimation only to prioritised arms", () => {
    const rows = new Map([
      ["a", row("a", 0.5)],
      ["b", row("b", 0.9)],
    ]);
    const cost = { forks: 2, searches: 30, embeddingCalls: 2, seconds: 12 };
    const arms = buildArms({
      candidates: pool,
      k: 4,
      seed: "59",
      priorities: rows,
      needOf: () => 0,
      estimationCost: cost,
    });
    expect(arms.unchanged.operations).toEqual([]);
    for (const name of ["recency", "random", "prioritised", "shuffled_batch"] as const) {
      expect(arms[name].operations).toHaveLength(4);
    }
    expect(arms.prioritised.operations.slice(0, 2).map((o) => o.id)).toEqual(["b", "a"]);
    expect(arms.shuffled_batch.operations.map((o) => o.id).toSorted()).toEqual(
      arms.prioritised.operations.map((o) => o.id).toSorted(),
    );
    expect(arms.prioritised.selectionCost).toEqual(cost);
    expect(arms.shuffled_batch.selectionCost).toEqual(cost);
    expect(arms.recency.selectionCost).toEqual(ZERO_SELECTION_COST);
    expect(arms.random.selectionCost).toEqual(ZERO_SELECTION_COST);
  });
});
