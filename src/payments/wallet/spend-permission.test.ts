import { describe, expect, it } from "vitest";
import { SpendPermissionPolicy } from "./spend-permission.js";

const DAY = 86_400;
const DAY_MS = DAY * 1000;

describe("SpendPermissionPolicy (PLAN-47 Phase 2)", () => {
  it("allows spend up to the allowance and denies past it", () => {
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY });
    const now = 5 * DAY_MS;
    expect(p.check(4, now).allowed).toBe(true);
    p.record(4, now);
    expect(p.remainingUsd(now)).toBe(6);
    expect(p.check(6, now).allowed).toBe(true);
    expect(p.check(6.01, now).allowed).toBe(false);
    expect(p.check(6.01, now).reason).toMatch(/exceeded/);
  });

  it("resets the allowance at the next period boundary", () => {
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY });
    const day5 = 5 * DAY_MS + 1000;
    p.record(10, day5);
    expect(p.check(1, day5).allowed).toBe(false); // window exhausted
    const day6 = 6 * DAY_MS + 1000;
    expect(p.remainingUsd(day6)).toBe(10); // new window, full allowance
    expect(p.check(10, day6).allowed).toBe(true);
  });

  it("counts only spends within the current window", () => {
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY });
    p.record(7, 5 * DAY_MS); // previous window
    p.record(3, 6 * DAY_MS); // current window
    expect(p.consumedUsd(6 * DAY_MS)).toBe(3);
    expect(p.remainingUsd(6 * DAY_MS)).toBe(7);
  });

  it("prune drops spends from earlier windows", () => {
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY });
    p.record(5, 4 * DAY_MS);
    p.record(2, 6 * DAY_MS);
    p.prune(6 * DAY_MS);
    expect(p.snapshot()).toHaveLength(1);
    expect(p.snapshot()[0]!.amountUsd).toBe(2);
  });

  it("rejects invalid amounts and invalid permissions", () => {
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY });
    expect(p.check(Number.NaN, 0).allowed).toBe(false);
    expect(p.check(-1, 0).allowed).toBe(false);
    expect(() => new SpendPermissionPolicy({ allowanceUsd: -1, periodSeconds: DAY })).toThrow();
    expect(() => new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: 0 })).toThrow();
  });

  it("honors a non-zero window anchor (start)", () => {
    const start = 1000 * DAY_MS;
    const p = new SpendPermissionPolicy({ allowanceUsd: 10, periodSeconds: DAY, startMs: start });
    expect(p.windowStart(start + 5000)).toBe(start);
    expect(p.windowStart(start + DAY_MS + 5000)).toBe(start + DAY_MS);
  });
});
