import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { CronEngine, MISSED_ONE_SHOT_MAX_AGE_MS } from "./engine.js";
import { lateNoteFor } from "./schedule.js";
import { loadJobsFile, saveJobsFile } from "./store.js";
import type { CronJob, CronRun } from "./types.js";

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

describe("one-shot jobs whose time has passed", () => {
  const HOUR = 60 * 60_000;
  const NOW = Date.UTC(2026, 9, 2, 14, 0, 0);

  function engineAt(
    storePath: string,
    main: Mock<(job: CronJob) => Promise<void>> = vi.fn(async (_job: CronJob) => {}),
  ) {
    return {
      main,
      engine: new CronEngine({
        storePath,
        enabled: true,
        tickMs: 10_000_000,
        nowMs: () => NOW,
        runners: { main, isolated: vi.fn(async () => undefined) },
      }),
    };
  }

  it("runs a job that was missed while the gateway was down", async () => {
    const { storePath } = await tempStore();
    const scheduled = NOW - 5 * HOUR;
    await saveJobsFile(storePath, {
      version: 1,
      jobs: [
        buildJob("reminder", {
          schedule: { kind: "at", at: new Date(scheduled).toISOString() },
          payload: { kind: "systemEvent", text: "Call the dentist." },
          nextRunAt: scheduled,
        }),
      ],
    });
    const { engine, main } = engineAt(storePath);
    await engine.start();
    expect(engine.getJob("reminder")?.nextRunAt).toBe(NOW);

    const run = await engine.runJob("reminder", "due");
    expect(run.status).toBe("ok");
    expect(main).toHaveBeenCalledTimes(1);
    // The runner gets the stored job unchanged; it adds the lateness note itself.
    expect(main.mock.calls[0]![0].payload).toEqual({
      kind: "systemEvent",
      text: "Call the dentist.",
    });
    // A successful one-shot is removed, so it cannot fire a second time.
    expect(engine.getJob("reminder")).toBeUndefined();
    await engine.stop();
  });

  it("does not re-run a one-shot that already ran, was started, is disabled, or is too old", async () => {
    const { storePath } = await tempStore();
    const past = { kind: "at" as const, at: new Date(NOW - HOUR).toISOString() };
    await saveJobsFile(storePath, {
      version: 1,
      jobs: [
        buildJob("done", {
          schedule: past,
          lastRunAt: NOW - HOUR,
          lastRunStatus: "ok",
          deleteAfterRun: false,
        }),
        buildJob("off", { schedule: past, enabled: false }),
        // Started and never finished: a restart or crash interrupted it.
        buildJob("interrupted", { schedule: past, lastStartedAt: NOW - HOUR }),
        buildJob("ancient", {
          schedule: {
            kind: "at",
            at: new Date(NOW - MISSED_ONE_SHOT_MAX_AGE_MS - HOUR).toISOString(),
          },
        }),
      ],
    });
    const { engine } = engineAt(storePath);
    await engine.start();
    for (const id of ["done", "off", "interrupted", "ancient"]) {
      expect(engine.getJob(id)?.nextRunAt, id).toBeUndefined();
    }
    await engine.stop();
  });

  it("records the start on disk before the run, so an interrupted run is not started again", async () => {
    const { storePath } = await tempStore();
    await saveJobsFile(storePath, {
      version: 1,
      jobs: [
        buildJob("once", { schedule: { kind: "at", at: new Date(NOW - HOUR).toISOString() } }),
      ],
    });
    let startedOnDisk: number | undefined;
    const main = vi.fn(async (_job: CronJob) => {
      startedOnDisk = (await loadJobsFile(storePath)).jobs[0]?.lastStartedAt;
      await new Promise<void>(() => {}); // the run never finishes
    });
    const { engine } = engineAt(storePath, main);
    await engine.start();
    void engine.runJob("once", "due");
    await vi.waitFor(() => expect(main).toHaveBeenCalledTimes(1));
    expect(startedOnDisk).toBe(NOW);

    // A second engine over the same file (a restart, or a config reload).
    const second = engineAt(storePath);
    await second.engine.start();
    expect(second.engine.getJob("once")?.nextRunAt).toBeUndefined();
    await second.engine.stop();
  });
});

describe("lateNoteFor", () => {
  const HOUR = 60 * 60_000;
  const NOW = Date.UTC(2026, 9, 2, 14, 0, 0);
  const at = (ms: number) => ({
    schedule: { kind: "at" as const, at: new Date(ms).toISOString() },
  });

  it("says nothing for a job that runs on time or for a recurring job", () => {
    expect(lateNoteFor(at(NOW - 30_000), NOW)).toBeUndefined();
    expect(lateNoteFor(at(NOW + HOUR), NOW)).toBeUndefined();
    expect(lateNoteFor({ schedule: { kind: "every", everyMs: 60_000 } }, NOW)).toBeUndefined();
  });

  it("names the scheduled time and the delay", () => {
    expect(lateNoteFor(at(NOW - 5 * HOUR), NOW)).toBe(
      `(Scheduled for ${new Date(NOW - 5 * HOUR).toISOString()}; running 5 hours late.)`,
    );
    expect(lateNoteFor(at(NOW - 3 * 24 * HOUR), NOW)).toContain("running 3 days late");
    expect(lateNoteFor(at(NOW - 20 * 60_000), NOW)).toContain("running 20 minutes late");
  });
});
