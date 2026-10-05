import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveCronEngine } from "../../cron/active.js";
import { CronEngine } from "../../cron/engine.js";
import { hasSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { createCronTool } from "./cron-tool.js";

/**
 * The agent's own scheduling tool, against a real engine with a fake clock
 * and stubbed runners.
 */

const nonOwner = vi.hoisted(() => ({ value: false }));
vi.mock("../run-owner-context.js", () => ({ currentRunIsNonOwner: () => nonOwner.value }));

let engine: CronEngine;
let main: ReturnType<typeof vi.fn>;
let now: number;
const tool = createCronTool({ agentSessionKey: "agent:main:main" });

const call = async (args: Record<string, unknown>) => {
  const result = (await tool.execute?.("call-1", args)) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(result.content[0].text) as Record<string, any>;
};

beforeEach(async () => {
  // Real time: creating a one-shot checks its time against the wall clock.
  now = Date.now();
  nonOwner.value = false;
  resetSystemEventsForTest();
  main = vi.fn(async () => {});
  const dir = await mkdtemp(path.join(tmpdir(), "bitterbot-cron-tool-"));
  engine = new CronEngine({
    storePath: path.join(dir, "jobs.json"),
    enabled: true,
    tickMs: 10_000_000,
    nowMs: () => now,
    runners: { main, isolated: vi.fn(async () => {}) },
  });
  await engine.start();
  setActiveCronEngine(engine);
});

afterEach(async () => {
  setActiveCronEngine(null);
  await engine.stop();
});

describe("cron tool", () => {
  it("schedules a reminder and lists it", async () => {
    const at = new Date(now + 20 * 60_000).toISOString();

    const added = await call({
      action: "add",
      job: { name: "Call the dentist", schedule: { kind: "at", at }, text: "Call the dentist" },
    });

    expect(added.ok).toBe(true);
    expect(added.job).toMatchObject({
      label: "Call the dentist",
      enabled: true,
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "Call the dentist" },
    });
    expect(added.job.nextRunAt).toBe(Date.parse(at));
    const listed = await call({ action: "list" });
    expect(listed.jobs).toHaveLength(1);
  });

  it("schedules recurring work as its own agent turn", async () => {
    const added = await call({
      action: "add",
      job: {
        name: "Friday summary",
        schedule: { kind: "cron", expr: "0 16 * * 5", tz: "UTC" },
        message: "Summarize this project's open tasks.",
      },
    });

    expect(added.job).toMatchObject({
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Summarize this project's open tasks." },
    });
  });

  it("does not let a job built for a non-owner run later with the owner's tools", async () => {
    nonOwner.value = true;

    const added = await call({
      action: "add",
      job: { schedule: { kind: "every", everyMs: 3_600_000 }, message: "check the inbox" },
    });

    expect(added.job.payload).toMatchObject({ kind: "agentTurn", senderIsOwner: false });
  });

  it("updates, runs, reports history and removes", async () => {
    const { job } = await call({
      action: "add",
      job: { name: "tick", schedule: { kind: "every", everyMs: 60_000 }, text: "tick" },
    });

    const paused = await call({ action: "update", id: job.id, patch: { enabled: false } });
    expect(paused.job.enabled).toBe(false);
    await call({ action: "update", id: job.id, patch: { enabled: true } });

    const run = await call({ action: "run", id: job.id });
    expect(run.status).toBe("ok");
    expect(main).toHaveBeenCalledTimes(1);

    const history = await call({ action: "runs", id: job.id });
    expect(history.count).toBe(1);
    expect(history.runs[0]).toMatchObject({ status: "ok", jobId: job.id });

    expect(await call({ action: "remove", id: job.id })).toEqual({ ok: true });
    expect((await call({ action: "list" })).jobs).toHaveLength(0);
  });

  it("turning a job back on clears the failures that turned it off", async () => {
    main.mockRejectedValue(new Error("down"));
    const { job } = await call({
      action: "add",
      job: { name: "flaky", schedule: { kind: "every", everyMs: 60_000 }, text: "x" },
    });
    for (let i = 0; i < 8; i += 1) {
      await call({ action: "run", id: job.id });
    }
    expect(engine.getJob(job.id)).toMatchObject({ enabled: false, consecutiveErrors: 8 });

    const back = await call({ action: "update", id: job.id, patch: { enabled: true } });

    expect(back.job).toMatchObject({ enabled: true, consecutiveErrors: 0 });
    expect(back.job.nextRunAt).toBeGreaterThan(now);
  });

  it("explains what is missing instead of failing obscurely", async () => {
    await expect(call({ action: "add" })).rejects.toThrow(/needs `job`/);
    await expect(call({ action: "run", id: "nope" })).rejects.toThrow(/No scheduled job/);
    await expect(
      call({ action: "add", job: { schedule: { kind: "cron", expr: "not a cron" }, text: "x" } }),
    ).rejects.toThrow();
    setActiveCronEngine(null);
    await expect(call({ action: "list" })).rejects.toThrow(/not available/);
  });

  it("queues a note for itself with wake", async () => {
    expect(await call({ action: "wake", text: "check the build" })).toMatchObject({ ok: true });
    expect(hasSystemEvents("agent:main:main")).toBe(true);
  });
});
