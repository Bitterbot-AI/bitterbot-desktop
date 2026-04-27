import { describe, expect, it } from "vitest";
import { applyBackoff, backoffDelayMs } from "./backoff.js";

describe("cron backoff", () => {
  it("returns zero delay when there have been no errors", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });

  it("walks the documented cadence: 30s → 1m → 5m → 15m → 60m", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(5 * 60_000);
    expect(backoffDelayMs(4)).toBe(15 * 60_000);
    expect(backoffDelayMs(5)).toBe(60 * 60_000);
    // Stays at 60m beyond the documented step count.
    expect(backoffDelayMs(99)).toBe(60 * 60_000);
  });

  it("never schedules earlier than the natural next-run", () => {
    const naturalNext = 100;
    expect(applyBackoff(naturalNext, 0, 0)).toBe(naturalNext);
    // After three consecutive errors, the soonest we can fire is now+5m.
    expect(applyBackoff(naturalNext, 3, 0)).toBe(5 * 60_000);
  });
});
