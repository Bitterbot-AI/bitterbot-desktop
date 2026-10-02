/**
 * From the adversarial review of the missed one-shot change in the cron
 * engine. Each test pins a defect the review found, now fixed.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronEngine } from "./engine.js";
import { deferredJobId } from "./isolated-agent.js";
import { buildJobFromParams } from "./normalize.js";
import { loadJobsFile, saveJobsFile } from "./store.js";
import type { CronJob } from "./types.js";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 2, 14, 0, 0);

function oneShot(jobId: string, atMs: number, overrides: Partial<CronJob> = {}): CronJob {
  return {
    jobId,
    name: jobId,
    enabled: true,
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Pay the invoice." },
    wakeMode: "now",
    deleteAfterRun: true,
    consecutiveErrors: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bitterbot-cron-review-"));
  return path.join(dir, "jobs.json");
}

function engineFor(
  storePath: string,
  isolated: (job: CronJob) => Promise<void>,
  now: () => number = () => NOW,
) {
  return new CronEngine({
    storePath,
    enabled: true,
    tickMs: 10_000_000,
    nowMs: now,
    runners: { main: vi.fn(async () => undefined), isolated },
  });
}

describe("missed one-shot (review)", () => {
  it("a one-shot that was mid-run when the engine was replaced is not run a second time", async () => {
    // The engine is replaced in-process on a `cron.*` config hot reload and on
    // every gateway restart. The start is recorded before the run.
    const storePath = await tempStore();
    const calls: string[] = [];
    let now = NOW - 1_000;
    const first = engineFor(
      storePath,
      async () => {
        calls.push("first engine");
        await new Promise<void>(() => {}); // the turn is still running
      },
      () => now,
    );
    await first.start();
    await first.upsertJob(oneShot("pay", NOW));
    now = NOW + 30_000;
    void first.runJob("pay", "due");
    await vi.waitFor(() => expect(calls).toEqual(["first engine"]));

    const second = engineFor(
      storePath,
      async () => {
        calls.push("second engine");
      },
      () => now,
    );
    await second.start();
    expect(second.getJob("pay")?.nextRunAt).toBeUndefined();
    const rerun = await second.runJob("pay", "due");
    expect(rerun.status).toBe("skipped");
    expect(calls).toEqual(["first engine"]);
    await second.stop();
  });

  it("a one-shot that went stale months ago does not fire on the first start after the upgrade", async () => {
    const storePath = await tempStore();
    // What the old engine left behind for every one-shot it dropped: enabled,
    // never run, no nextRunAt.
    await saveJobsFile(storePath, {
      version: 1,
      jobs: [
        oneShot("old-reminder", NOW - 90 * 24 * HOUR),
        oneShot("old-wakeup", NOW - 60 * 24 * HOUR),
        oneShot("yesterday", NOW - 24 * HOUR),
      ],
    });
    const engine = engineFor(storePath, async () => undefined);
    await engine.start();
    expect(engine.getJob("old-reminder")?.nextRunAt).toBeUndefined();
    expect(engine.getJob("old-wakeup")?.nextRunAt).toBeUndefined();
    expect(engine.getJob("yesterday")?.nextRunAt).toBe(NOW);
    await engine.stop();
  });

  it("a new job with a time already in the past is refused when it is created", () => {
    // e.g. "2026-10-02T09:00:00" typed as local time: it is read as UTC.
    const fiveHoursAgo = new Date(Date.now() - 5 * HOUR).toISOString();
    expect(() => buildJobFromParams({ at: fiveHoursAgo, text: "Call the dentist." })).toThrow(
      /is in the past/,
    );
    // A few seconds of skew between the caller and the gateway is fine.
    const justNow = new Date(Date.now() - 5_000).toISOString();
    expect(buildJobFromParams({ at: justNow, text: "now" }).schedule.kind).toBe("at");
  });
});

describe("task-wakeup deferral (review)", () => {
  it("the deferred wakeup survives the bookkeeping of the run that deferred it", async () => {
    // runIsolatedJob defers a task wakeup at capacity by upserting a copy
    // under a new job id and returning normally; the engine then deletes the
    // one-shot it just ran. Re-using the id had the deferral deleted with it.
    const storePath = await tempStore();
    let engine!: CronEngine;
    let deferredId = "";
    engine = engineFor(storePath, async (job) => {
      deferredId = deferredJobId(job.jobId);
      await engine.upsertJob({
        ...job,
        jobId: deferredId,
        schedule: { kind: "at", at: new Date(NOW + 60_000).toISOString() },
        nextRunAt: NOW + 60_000,
        lastRunAt: undefined,
        lastStartedAt: undefined,
        lastRunStatus: undefined,
      });
    });
    await engine.start();
    await engine.upsertJob(oneShot("task-wakeup-t1", NOW));
    const run = await engine.runJob("task-wakeup-t1", "due");
    expect(run.status).toBe("ok");
    expect(engine.getJob("task-wakeup-t1")).toBeUndefined();
    const deferred = engine.getJob(deferredId);
    expect(deferred?.enabled).toBe(true);
    expect(deferred?.nextRunAt).toBe(NOW + 60_000);
    expect((await loadJobsFile(storePath)).jobs.map((job) => job.jobId)).toEqual([deferredId]);
    await engine.stop();
  });

  it("a wakeup deferred many times keeps one suffix", () => {
    const once = deferredJobId("task-wakeup-t1");
    expect(once).toMatch(/^task-wakeup-t1-d[0-9a-z]+$/);
    expect(deferredJobId(once)).toMatch(/^task-wakeup-t1-d[0-9a-z]+$/);
  });

  it("a late wakeup's stored job is not changed by the lateness note", async () => {
    const storePath = await tempStore();
    let received: CronJob | undefined;
    const engine = engineFor(storePath, async (job) => {
      received = job;
    });
    await saveJobsFile(storePath, {
      version: 1,
      jobs: [oneShot("task-wakeup-t3", NOW - 3 * HOUR)],
    });
    await engine.start();
    await engine.runJob("task-wakeup-t3", "due");
    // The runner adds the note to the text it sends; the job object it is
    // handed, and so anything it stores from it, has the original message.
    expect(received?.payload).toMatchObject({ message: "Pay the invoice." });
    await engine.stop();
  });
});
