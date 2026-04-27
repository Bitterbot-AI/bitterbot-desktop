import { describe, expect, it } from "vitest";
import {
  assertScheduleValid,
  computeNextRunAt,
  describeSchedule,
  parseSchedule,
} from "./schedule.js";

describe("cron schedule", () => {
  it("parses ISO timestamps as UTC when no offset is provided", () => {
    const fromUtc = computeNextRunAt({ kind: "at", at: "2099-01-01T00:00:00" }, 0);
    expect(fromUtc).toBe(Date.parse("2099-01-01T00:00:00Z"));
  });

  it("returns null for one-shot schedules in the past", () => {
    const past = "2000-01-01T00:00:00Z";
    expect(computeNextRunAt({ kind: "at", at: past }, Date.now())).toBeNull();
  });

  it("computes next-run for every-schedules from `from`", () => {
    const next = computeNextRunAt({ kind: "every", everyMs: 60_000 }, 1_000);
    expect(next).toBe(61_000);
  });

  it("uses croner for cron expressions", () => {
    const parsed = parseSchedule({ kind: "cron", expr: "0 * * * *", tz: "UTC" });
    // Asking from 12:00:30 UTC, the next on-the-hour fire is 13:00 UTC.
    const ref = Date.UTC(2026, 0, 1, 12, 0, 30);
    const next = parsed.nextRunAt(ref);
    expect(next).toBe(Date.UTC(2026, 0, 1, 13, 0, 0));
  });

  it("rejects sub-second every intervals", () => {
    expect(() => assertScheduleValid({ kind: "every", everyMs: 50 })).toThrow(/everyMs/);
  });

  it("rejects malformed cron expressions", () => {
    expect(() => assertScheduleValid({ kind: "cron", expr: "totally bogus" })).toThrow(
      /invalid cron/,
    );
  });

  it("renders the legacy schedule string", () => {
    expect(describeSchedule({ kind: "at", at: "2099-01-01T00:00:00Z" })).toBe(
      "at 2099-01-01T00:00:00Z",
    );
    expect(describeSchedule({ kind: "every", everyMs: 60_000 })).toBe("every 60000ms");
    expect(describeSchedule({ kind: "cron", expr: "* * * * *", tz: "UTC" })).toBe(
      "* * * * * (UTC)",
    );
  });
});
