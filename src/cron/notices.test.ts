import { describe, expect, it } from "vitest";
import { ownerNoticeForCronEvent } from "./notices.js";
import type { CronJob, CronRun } from "./types.js";

const job = (overrides: Partial<CronJob> = {}): CronJob => ({
  jobId: "j1",
  name: "Friday report",
  enabled: true,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: "report" },
  wakeMode: "now",
  consecutiveErrors: 1,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});
const failed: CronRun = { ts: 1, jobId: "j1", status: "error", error: "no route to telegram" };

describe("ownerNoticeForCronEvent", () => {
  it("speaks up at the start of a failure streak, with the error and the retry", () => {
    const notice = ownerNoticeForCronEvent({
      kind: "run",
      run: failed,
      job: job({ nextRunAt: Date.UTC(2026, 9, 5, 15, 30) }),
    });

    expect(notice?.kind).toBe("cron-error");
    expect(notice?.text).toContain('Scheduled job "Friday report" failed.');
    expect(notice?.text).toContain("no route to telegram");
    expect(notice?.text).toContain("It will try again around");
  });

  it("stays quiet for the rest of the streak and for runs that worked", () => {
    expect(
      ownerNoticeForCronEvent({ kind: "run", run: failed, job: job({ consecutiveErrors: 2 }) }),
    ).toBeNull();
    expect(
      ownerNoticeForCronEvent({
        kind: "run",
        run: { ts: 1, jobId: "j1", status: "ok" },
        job: job({ consecutiveErrors: 0 }),
      }),
    ).toBeNull();
    expect(ownerNoticeForCronEvent({ kind: "run", run: failed, job: null })).toBeNull();
  });

  it("says when a job has been turned off, and how to bring it back", () => {
    const notice = ownerNoticeForCronEvent({
      kind: "disabled",
      run: failed,
      job: job({ enabled: false, consecutiveErrors: 8 }),
    });

    expect(notice?.kind).toBe("cron-disabled");
    expect(notice?.text).toContain("failed 8 times in a row and has been turned off");
    expect(notice?.text).toContain("Cron page");
  });

  it("says when a one-shot will not run again, and does not also report the run", () => {
    const gaveUp = job({ enabled: false, consecutiveErrors: 3, schedule: { kind: "at", at: "x" } });

    expect(ownerNoticeForCronEvent({ kind: "gave-up", run: failed, job: gaveUp })?.text).toContain(
      "will not run again (tried 3 times)",
    );
    expect(
      ownerNoticeForCronEvent({
        kind: "run",
        run: failed,
        job: { ...gaveUp, consecutiveErrors: 1 },
      }),
    ).toBeNull();
  });
});
