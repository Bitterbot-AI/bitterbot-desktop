import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronJob, CronRun } from "./types.js";
import { appendRun, loadJobsFile, readRuns, resolveCronPaths, saveJobsFile } from "./store.js";

function sampleJob(jobId = "job1"): CronJob {
  return {
    jobId,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "tick" },
    wakeMode: "now",
    consecutiveErrors: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "bitterbot-cron-"));
}

describe("cron store", () => {
  it("returns an empty file when jobs.json does not exist", async () => {
    const dir = await tempDir();
    const file = await loadJobsFile(path.join(dir, "missing.json"));
    expect(file).toEqual({ version: 1, jobs: [] });
  });

  it("writes atomically and round-trips a job list", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "jobs.json");
    const job = sampleJob();
    await saveJobsFile(target, { version: 1, jobs: [job] });
    const reloaded = await loadJobsFile(target);
    expect(reloaded.jobs).toHaveLength(1);
    expect(reloaded.jobs[0].jobId).toBe("job1");
    const fileContents = await readFile(target, "utf8");
    expect(fileContents).toContain('"version": 1');
  });

  it("ignores rows missing a jobId on load", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "jobs.json");
    await saveJobsFile(target, {
      version: 1,
      // @ts-expect-error — testing tolerance for malformed legacy rows.
      jobs: [{ name: "bad" }, sampleJob()],
    });
    const reloaded = await loadJobsFile(target);
    expect(reloaded.jobs).toHaveLength(1);
    expect(reloaded.jobs[0].jobId).toBe("job1");
  });

  it("appends and reads run history", async () => {
    const dir = await tempDir();
    const { runsDir } = resolveCronPaths({ storePath: path.join(dir, "jobs.json") });
    const runs: CronRun[] = [
      { ts: 1, jobId: "job1", status: "ok", durationMs: 5 },
      { ts: 2, jobId: "job1", status: "error", durationMs: 7, error: "boom" },
    ];
    for (const run of runs) {
      await appendRun(runsDir, run);
    }
    const recent = await readRuns(runsDir, "job1", 10);
    expect(recent).toHaveLength(2);
    expect(recent[0].ts).toBe(1);
    expect(recent[1].error).toBe("boom");
  });
});
