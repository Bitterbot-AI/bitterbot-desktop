/**
 * PLAN-64 Phase 5: deleting an isolated job tells the practices side, so the
 * job's generated EXPERIENCE.md and its announcement records go with it.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";

const mocks = vi.hoisted(() => ({ forget: vi.fn(async (_cfg: unknown, _job: unknown) => {}) }));

vi.mock("./job-practices.js", () => ({
  forgetJobPractices: mocks.forget,
  beginJobAnnouncement: async () => ({ canaryLine: null, announced: () => {} }),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});

const { CronEngine } = await import("./engine.js");

function job(jobId: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    jobId,
    name: jobId,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "report" },
    wakeMode: "now",
    consecutiveErrors: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

async function engine() {
  const dir = await mkdtemp(path.join(tmpdir(), "bitterbot-cron-practices-"));
  const e = new CronEngine({
    storePath: path.join(dir, "jobs.json"),
    enabled: true,
    tickMs: 10_000_000,
    nowMs: () => 1_000_000,
    runners: { main: vi.fn(async () => undefined), isolated: vi.fn(async () => undefined) },
  });
  await e.start();
  return e;
}

beforeEach(() => {
  mocks.forget.mockClear();
});

describe("CronEngine and job practices", () => {
  it("removeJob forgets the practices side of an isolated job, once the delete was saved", async () => {
    const e = await engine();
    await e.upsertJob(job("report-1"));
    expect(await e.removeJob("report-1")).toBe(true);
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledTimes(1));
    expect(mocks.forget.mock.calls[0]![1]).toMatchObject({ jobId: "report-1" });
    // Nothing to forget for a job that was not there, or for a main-session job.
    expect(await e.removeJob("report-1")).toBe(false);
    await e.upsertJob(
      job("ping", { sessionTarget: "main", payload: { kind: "systemEvent", text: "tick" } }),
    );
    await e.removeJob("ping");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.forget).toHaveBeenCalledTimes(1);
    await e.stop();
  });

  it("a one-shot that is deleted after its run is forgotten too", async () => {
    const e = await engine();
    await e.upsertJob(
      job("once", { schedule: { kind: "at", at: new Date(2_000_000).toISOString() } }),
    );
    await e.runJob("once");
    await vi.waitFor(() => expect(mocks.forget).toHaveBeenCalledTimes(1));
    expect(e.getJob("once")).toBeUndefined();
    await e.stop();
  });
});
