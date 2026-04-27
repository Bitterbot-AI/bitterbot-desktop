import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CronJob, CronRun } from "./types.js";
import { CronEngine } from "./engine.js";
import { loadJobsFile } from "./store.js";

function buildJob(jobId: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    jobId,
    name: jobId,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "tick" },
    wakeMode: "now",
    consecutiveErrors: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function tempStore(): Promise<{ storePath: string; runsDir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "bitterbot-cron-engine-"));
  return { storePath: path.join(dir, "jobs.json"), runsDir: path.join(dir, "runs") };
}

describe("CronEngine", () => {
  it("upserts jobs, computes nextRunAt, and persists to disk", async () => {
    const { storePath } = await tempStore();
    let now = 1_000_000;
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main: vi.fn(async () => undefined), isolated: vi.fn(async () => undefined) },
    });
    await engine.start();
    const job = buildJob("job1");
    const stored = await engine.upsertJob(job);
    expect(stored.nextRunAt).toBe(now + 60_000);
    const fileContents = await loadJobsFile(storePath);
    expect(fileContents.jobs).toHaveLength(1);
    expect(fileContents.jobs[0].nextRunAt).toBe(now + 60_000);
    await engine.stop();
  });

  it("force-runs a job and records the run in history", async () => {
    const { storePath } = await tempStore();
    let now = 5_000_000;
    const main = vi.fn(async () => undefined);
    const finished: CronRun[] = [];
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main, isolated: vi.fn(async () => undefined) },
      onRunFinished: (run) => finished.push(run),
    });
    await engine.start();
    await engine.upsertJob(buildJob("job1"));
    const result = await engine.runJob("job1", "force");
    expect(main).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("ok");
    expect(finished).toHaveLength(1);
    expect(finished[0].trigger).toBe("manual");
    await engine.stop();
  });

  it("treats a `due` run as skipped when the job is not yet due", async () => {
    const { storePath } = await tempStore();
    let now = 0;
    const main = vi.fn(async () => undefined);
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main, isolated: vi.fn(async () => undefined) },
    });
    await engine.start();
    await engine.upsertJob(buildJob("job1"));
    const run = await engine.runJob("job1", "due");
    expect(run.status).toBe("skipped");
    expect(main).not.toHaveBeenCalled();
    await engine.stop();
  });

  it("disables one-shot at-jobs that fail and keeps them around when keep-after-run", async () => {
    const { storePath } = await tempStore();
    let now = 1_000;
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main: failing, isolated: vi.fn(async () => undefined) },
    });
    await engine.start();
    await engine.upsertJob(
      buildJob("oneshot", {
        schedule: { kind: "at", at: new Date(now + 100).toISOString() },
        deleteAfterRun: false,
      }),
    );
    const result = await engine.runJob("oneshot", "force");
    expect(result.status).toBe("error");
    const remaining = engine.getJob("oneshot");
    expect(remaining).toBeDefined();
    expect(remaining?.enabled).toBe(false);
    await engine.stop();
  });

  it("reports nextWakeAtMs as the earliest enabled-job nextRunAt", async () => {
    const { storePath } = await tempStore();
    const now = 1_000_000;
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main: vi.fn(async () => undefined), isolated: vi.fn(async () => undefined) },
    });
    await engine.start();
    expect(engine.status().nextWakeAtMs).toBeNull();

    await engine.upsertJob(buildJob("near", { schedule: { kind: "every", everyMs: 60_000 } }));
    await engine.upsertJob(buildJob("far", { schedule: { kind: "every", everyMs: 600_000 } }));
    await engine.upsertJob(
      buildJob("disabled", {
        enabled: false,
        schedule: { kind: "every", everyMs: 1_000 },
      }),
    );
    expect(engine.status().nextWakeAtMs).toBe(now + 60_000);
    await engine.stop();
  });

  it("removes one-shot jobs after a successful default run", async () => {
    const { storePath } = await tempStore();
    let now = 1_000;
    const main = vi.fn(async () => undefined);
    const engine = new CronEngine({
      storePath,
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => now,
      runners: { main, isolated: vi.fn(async () => undefined) },
    });
    await engine.start();
    await engine.upsertJob(
      buildJob("oneshot", {
        schedule: { kind: "at", at: new Date(now + 100).toISOString() },
      }),
    );
    const result = await engine.runJob("oneshot", "force");
    expect(result.status).toBe("ok");
    expect(engine.getJob("oneshot")).toBeUndefined();
    await engine.stop();
  });
});
