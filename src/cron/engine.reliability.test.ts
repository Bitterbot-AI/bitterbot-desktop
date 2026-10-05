import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronEngine, type CronEngineEvent, type CronEngineOptions } from "./engine.js";
import type { CronJob } from "./types.js";

/**
 * PLAN-53 Track E: a scheduled job must not fail quietly for ever, a one-shot
 * may be asked to keep trying, and an interval job must survive restarts.
 */

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

async function harness(extra: Partial<CronEngineOptions> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "bitterbot-cron-reliability-"));
  const clock = { now: 1_000_000 };
  const events: CronEngineEvent[] = [];
  const main = vi.fn(async () => {});
  const make = () =>
    new CronEngine({
      storePath: path.join(dir, "jobs.json"),
      enabled: true,
      tickMs: 10_000_000,
      nowMs: () => clock.now,
      runners: { main, isolated: vi.fn(async () => {}) },
      onEvent: (event) => events.push(event),
      ...extra,
    });
  return { clock, events, main, make };
}

describe("a recurring job that keeps failing", () => {
  it("is turned off after the limit, and says so once", async () => {
    const { events, main, make } = await harness({ autoDisableAfterErrors: 3 });
    main.mockRejectedValue(new Error("upstream is down"));
    const engine = make();
    await engine.start();
    await engine.upsertJob(buildJob("flaky"));

    for (let i = 0; i < 3; i += 1) {
      await engine.runJob("flaky", "force");
    }

    const job = engine.listJobs({ includeDisabled: true }).find((j) => j.jobId === "flaky");
    expect(job).toMatchObject({ enabled: false, consecutiveErrors: 3, nextRunAt: undefined });
    expect(events.map((e) => e.kind)).toEqual(["run", "run", "run", "disabled"]);
    expect(events.at(-1)).toMatchObject({ run: { status: "error", error: "upstream is down" } });
    await engine.stop();
  });

  it("is left running when the limit is 0, and a success clears the streak", async () => {
    const { events, main, make } = await harness({ autoDisableAfterErrors: 0 });
    main.mockRejectedValue(new Error("nope"));
    const engine = make();
    await engine.start();
    await engine.upsertJob(buildJob("stubborn"));

    for (let i = 0; i < 12; i += 1) {
      await engine.runJob("stubborn", "force");
    }
    expect(engine.listJobs().find((j) => j.jobId === "stubborn")?.enabled).toBe(true);

    main.mockResolvedValue(undefined);
    await engine.runJob("stubborn", "force");
    expect(engine.listJobs().find((j) => j.jobId === "stubborn")?.consecutiveErrors).toBe(0);
    expect(events.some((e) => e.kind === "disabled")).toBe(false);
    await engine.stop();
  });
});

describe("a one-shot job", () => {
  const oneShot = (overrides: Partial<CronJob> = {}) =>
    buildJob("once", {
      schedule: { kind: "at", at: new Date(1_000_500).toISOString() },
      deleteAfterRun: false,
      ...overrides,
    });

  it("that fails is reported as given up, with its failure kept on the job", async () => {
    const { events, main, make } = await harness();
    main.mockRejectedValue(new Error("no route"));
    const engine = make();
    await engine.start();
    await engine.upsertJob(oneShot());

    await engine.runJob("once", "force");

    const job = engine.listJobs({ includeDisabled: true }).find((j) => j.jobId === "once");
    expect(job).toMatchObject({ enabled: false, consecutiveErrors: 1, lastRunStatus: "error" });
    expect(events.map((e) => e.kind)).toEqual(["run", "gave-up"]);
    await engine.stop();
  });

  it("with a retry deadline keeps trying with backoff, then gives up at the deadline", async () => {
    const { clock, events, main, make } = await harness();
    main.mockRejectedValue(new Error("no route"));
    const engine = make();
    await engine.start();
    // Backoff is 30 s then 1 min; the deadline allows the first retry only.
    await engine.upsertJob(oneShot({ retryUntilMs: clock.now + 45_000 }));

    await engine.runJob("once", "force");
    let job = engine.listJobs().find((j) => j.jobId === "once");
    expect(job).toMatchObject({
      enabled: true,
      consecutiveErrors: 1,
      nextRunAt: clock.now + 30_000,
    });
    expect(events.map((e) => e.kind)).toEqual(["run"]);

    clock.now += 30_000;
    await engine.runJob("once", "due");
    job = engine.listJobs({ includeDisabled: true }).find((j) => j.jobId === "once");
    expect(job).toMatchObject({ enabled: false, consecutiveErrors: 2 });
    expect(events.map((e) => e.kind)).toEqual(["run", "run", "gave-up"]);
    await engine.stop();
  });

  it("keeps its retry time across a restart", async () => {
    const { clock, main, make } = await harness();
    main.mockRejectedValue(new Error("no route"));
    const first = make();
    await first.start();
    await first.upsertJob(oneShot({ retryUntilMs: clock.now + 3_600_000 }));
    await first.runJob("once", "force");
    const retryAt = first.listJobs().find((j) => j.jobId === "once")?.nextRunAt;
    await first.stop();

    clock.now += 5_000;
    const second = make();
    await second.start();

    expect(retryAt).toBe(1_000_000 + 30_000);
    expect(second.listJobs().find((j) => j.jobId === "once")?.nextRunAt).toBe(retryAt);
    await second.stop();
  });

  it("that succeeds is reported with no job left behind", async () => {
    const { events, make } = await harness();
    const engine = make();
    await engine.start();
    await engine.upsertJob(oneShot({ deleteAfterRun: true }));

    await engine.runJob("once", "force");

    expect(events).toMatchObject([{ kind: "run", job: null, run: { status: "ok" } }]);
    await engine.stop();
  });
});

describe("an interval job across restarts", () => {
  it("stays on its grid instead of sliding a full interval on every start", async () => {
    const { clock, make } = await harness();
    const hour = 3_600_000;
    const first = make();
    await first.start();
    await first.upsertJob(buildJob("hourly", { schedule: { kind: "every", everyMs: hour } }));
    const firstDue = first.listJobs().find((j) => j.jobId === "hourly")?.nextRunAt;
    expect(firstDue).toBe(clock.now + hour);
    await first.stop();

    // Restart 40 minutes in. It used to be pushed to now + 1 h.
    clock.now += 40 * 60_000;
    const second = make();
    await second.start();
    expect(second.listJobs().find((j) => j.jobId === "hourly")?.nextRunAt).toBe(firstDue);
    await second.stop();
  });

  it("runs once at the next tick when its slot passed while the gateway was down", async () => {
    const { clock, main, make } = await harness();
    const hour = 3_600_000;
    const first = make();
    await first.start();
    await first.upsertJob(buildJob("hourly", { schedule: { kind: "every", everyMs: hour } }));
    await first.stop();

    clock.now += 2.5 * hour;
    const second = make();
    await second.start();
    expect(second.listJobs().find((j) => j.jobId === "hourly")?.nextRunAt).toBe(clock.now);

    await second.runJob("hourly", "due");
    expect(main).toHaveBeenCalledTimes(1);
    // Back on the grid: three hours after the anchor.
    expect(second.listJobs().find((j) => j.jobId === "hourly")?.nextRunAt).toBe(
      1_000_000 + 3 * hour,
    );
    await second.stop();
  });
});
