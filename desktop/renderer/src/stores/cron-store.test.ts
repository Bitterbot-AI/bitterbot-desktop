import { describe, expect, it } from "vitest";
import { cronJobHealth, type CronJob } from "./cron-store";

const job = (overrides: Partial<CronJob>): CronJob => ({
  id: "j1",
  schedule: "0 9 * * *",
  text: "report",
  enabled: true,
  ...overrides,
});

describe("cronJobHealth", () => {
  it("says a job that was turned off for failing was turned off for failing", () => {
    expect(
      cronJobHealth(job({ enabled: false, consecutiveErrors: 8, lastRunStatus: "error" })),
    ).toEqual({
      tone: "bad",
      text: "Turned off after 8 failures in a row",
    });
  });

  it("tells a failing job from one that failed once", () => {
    expect(cronJobHealth(job({ lastRunStatus: "error", consecutiveErrors: 3 })).text).toBe(
      "Failing (3 in a row)",
    );
    expect(cronJobHealth(job({ lastRunStatus: "error", consecutiveErrors: 1 }))).toEqual({
      tone: "warn",
      text: "Last run failed",
    });
  });

  it("covers a one-shot that gave up, a healthy job, a new job and a job switched off", () => {
    expect(
      cronJobHealth(job({ enabled: false, lastRunStatus: "error", consecutiveErrors: 1 })).text,
    ).toBe("Failed and will not run again");
    expect(cronJobHealth(job({ lastRunStatus: "ok", consecutiveErrors: 0 })).tone).toBe("ok");
    expect(cronJobHealth(job({})).text).toBe("Has not run yet");
    expect(cronJobHealth(job({ enabled: false })).text).toBe("Off");
  });
});
