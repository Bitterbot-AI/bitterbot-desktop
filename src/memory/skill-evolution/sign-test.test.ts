/**
 * The gate statistic: exact one-sided sign test. Pins the arithmetic the
 * research pass established — 5 clean wins is the minimum promotable
 * evidence (p = 0.5^5 ≈ 0.031); anything the old bootstrap gate silently
 * mishandled (ties, tiny n) is well-defined here.
 */

import { describe, expect, it } from "vitest";
import { exactSignTest } from "./sign-test.js";

describe("exactSignTest", () => {
  it("no discordant pairs = no evidence (p=1)", () => {
    expect(exactSignTest([0, 0, 0]).pValue).toBe(1);
    expect(exactSignTest([]).pValue).toBe(1);
  });

  it("5 clean wins is the minimum promotable evidence", () => {
    const four = exactSignTest([1, 1, 1, 1, 0, 0]);
    expect(four.pValue).toBeCloseTo(0.0625, 4);
    expect(four.pValue).toBeGreaterThan(0.05);

    const five = exactSignTest([1, 1, 1, 1, 1, 0, 0, 0]);
    expect(five.pValue).toBeCloseTo(0.03125, 5);
    expect(five.pValue).toBeLessThan(0.05);
    expect(five.wins).toBe(5);
    expect(five.ties).toBe(3);
  });

  it("losses cost more than ties: 6 wins 1 loss is not enough, 7-1 is", () => {
    // P(X>=6 | Bin(7,0.5)) = 8/128 = 0.0625
    expect(exactSignTest([1, 1, 1, 1, 1, 1, -1]).pValue).toBeCloseTo(0.0625, 4);
    // P(X>=7 | Bin(8,0.5)) = 9/256 ≈ 0.0352
    expect(exactSignTest([1, 1, 1, 1, 1, 1, 1, -1]).pValue).toBeCloseTo(0.03516, 4);
  });

  it("fractional deltas (K-trial pass rates) count by sign", () => {
    const r = exactSignTest([1 / 3, 2 / 3, -1 / 3, 0, 1 / 3]);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(1);
    expect(r.ties).toBe(1);
  });

  it("a losing candidate is never significant", () => {
    expect(exactSignTest([-1, -1, -1, -1, -1]).pValue).toBeGreaterThan(0.96);
  });
});
