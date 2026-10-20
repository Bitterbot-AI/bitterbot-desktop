/**
 * PLAN-49 Phase 2: the monthly funding ceiling (invariant I3). A top-up is
 * allowed only within the ceiling; the ceiling is hard.
 */
import { describe, expect, it } from "vitest";
import { checkFundingWithinCeiling } from "./funding-policy.js";

const NOW = 1_000_000_000_000;

describe("funding-policy — monthly ceiling (PLAN-49 Phase 2)", () => {
  it("allows a top-up within the ceiling and reports headroom", () => {
    const r = checkFundingWithinCeiling({ requestUsd: 20, ceilingUsd: 50, now: NOW });
    expect(r.allowed).toBe(true);
    expect(r.remainingUsd).toBe(30);
  });

  it("blocks a top-up that would exceed the ceiling (I3 hard)", () => {
    const r = checkFundingWithinCeiling({
      requestUsd: 40,
      ceilingUsd: 50,
      priorTopUps: [{ amountUsd: 20, atMs: NOW - 1000 }],
      now: NOW,
    });
    expect(r.allowed).toBe(false); // 20 + 40 > 50
  });

  it("counts prior top-ups in the period against headroom", () => {
    const r = checkFundingWithinCeiling({
      requestUsd: 10,
      ceilingUsd: 50,
      priorTopUps: [
        { amountUsd: 20, atMs: NOW - 1000 },
        { amountUsd: 15, atMs: NOW - 2000 },
      ],
      now: NOW,
    });
    expect(r.allowed).toBe(true); // 35 + 10 <= 50
    expect(r.remainingUsd).toBe(5);
  });

  it("a ceiling of 0 blocks all funding", () => {
    expect(checkFundingWithinCeiling({ requestUsd: 1, ceilingUsd: 0, now: NOW }).allowed).toBe(
      false,
    );
  });

  it("an undefined ceiling is unbounded by this check", () => {
    const r = checkFundingWithinCeiling({ requestUsd: 1000, now: NOW });
    expect(r.allowed).toBe(true);
    expect(r.remainingUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects a non-positive or non-finite amount", () => {
    expect(checkFundingWithinCeiling({ requestUsd: 0, ceilingUsd: 50 }).allowed).toBe(false);
    expect(checkFundingWithinCeiling({ requestUsd: -5, ceilingUsd: 50 }).allowed).toBe(false);
    expect(checkFundingWithinCeiling({ requestUsd: Number.NaN, ceilingUsd: 50 }).allowed).toBe(
      false,
    );
  });
});
