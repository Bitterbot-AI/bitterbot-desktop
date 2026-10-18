import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { Task } from "../../tasks/types.js";
import type { ComputeJobSummary } from "./backend.js";
import {
  COMPUTE_TASK_FALLBACK_WAKEUP_MS,
  completeComputeTaskLink,
  linkComputeJobToTask,
} from "./task-link.js";

const NOW = 1_700_000_000_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    goal: "embed the corpus",
    doneCriteria: "vectors stored",
    status: "running",
    parentTaskId: null,
    plan: null,
    checkpoint: null,
    currentRunId: null,
    output: null,
    checks: [],
    verification: null,
    judgeRounds: 0,
    source: "user",
    bounty: null,
    agentSessionKey: "agent:main:task-1",
    wakeupCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    lastSeenAt: NOW,
    metadata: { note: "keep" },
    ...over,
  };
}

function fakeStore(initial: Task) {
  let current = initial;
  return {
    updates: [] as Array<Record<string, unknown>>,
    get: (id: string) => (id === current.id ? current : undefined),
    update(id: string, input: Record<string, unknown>) {
      this.updates.push(input);
      current = { ...current, ...(input as Partial<Task>) };
      return current;
    },
    current: () => current,
  };
}

function fakeCron() {
  const jobs = new Map<string, CronJob>();
  return {
    jobs,
    upsertJob: vi.fn(async (job: CronJob) => {
      jobs.set(job.jobId, job);
      return job;
    }),
    getJob: (id: string) => jobs.get(id),
  };
}

const job: ComputeJobSummary = {
  id: "j9",
  status: "succeeded",
  mode: "private",
  scope: "lab",
  workload: "embeddings",
  items: 40,
  attempts: 1,
  worker: "gpu-1",
  verification: "shape_only_trusted_worker",
};

describe("linkComputeJobToTask", () => {
  it("parks the task in waiting_external, records the job, and schedules a fallback wakeup", async () => {
    const store = fakeStore(task());
    const cron = fakeCron();
    const link = await linkComputeJobToTask(
      { taskId: "t1", jobId: "j9", workload: "embeddings", items: 40, reason: "index the corpus" },
      { taskStore: store, cron, now: () => NOW },
    );
    expect(link).toEqual({ taskId: "t1", wakeupJobId: "task-wakeup-t1-compute-j9" });
    expect(store.current().status).toBe("waiting_external");
    expect(store.current().metadata).toMatchObject({
      note: "keep",
      computeJobs: {
        j9: { status: "submitted", workload: "embeddings", items: 40, submittedAt: NOW },
      },
    });
    expect(store.updates[0]).toMatchObject({ incrementWakeup: true });
    const scheduled = cron.jobs.get("task-wakeup-t1-compute-j9")!;
    expect(scheduled.schedule).toEqual({
      kind: "at",
      at: new Date(NOW + COMPUTE_TASK_FALLBACK_WAKEUP_MS).toISOString(),
    });
    expect(scheduled.payload).toMatchObject({ kind: "agentTurn", taskId: "t1" });
    expect(String((scheduled.payload as { message: string }).message)).toContain(
      "compute job_id=j9",
    );
    expect(scheduled.deleteAfterRun).toBe(true);
  });

  it("still links without a cron engine, and says so", async () => {
    const store = fakeStore(task());
    const link = await linkComputeJobToTask(
      { taskId: "t1", jobId: "j9", workload: "sha256", items: 3 },
      { taskStore: store, cron: null, now: () => NOW },
    );
    expect(link).toEqual({ taskId: "t1", wakeupJobId: null });
    expect(store.updates[0]).toMatchObject({ status: "waiting_external", incrementWakeup: false });
  });

  it("refuses a missing or finished task, and a missing store", async () => {
    expect(
      await linkComputeJobToTask(
        { taskId: "nope", jobId: "j", workload: "sha256", items: 1 },
        { taskStore: fakeStore(task()), cron: null },
      ),
    ).toEqual({ error: "task nope not found" });
    expect(
      await linkComputeJobToTask(
        { taskId: "t1", jobId: "j", workload: "sha256", items: 1 },
        { taskStore: fakeStore(task({ status: "completed" })), cron: null },
      ),
    ).toEqual({ error: "task t1 is completed" });
    expect(
      await linkComputeJobToTask(
        { taskId: "t1", jobId: "j", workload: "sha256", items: 1 },
        { taskStore: null, cron: null },
      ),
    ).toEqual({ error: "task store is not active" });
  });
});

describe("completeComputeTaskLink", () => {
  it("records the outcome on the task and pulls the fallback wakeup forward to now", async () => {
    const store = fakeStore(
      task({
        status: "waiting_external",
        metadata: { computeJobs: { j9: { status: "submitted" } } },
      }),
    );
    const cron = fakeCron();
    cron.jobs.set("wk", {
      jobId: "wk",
      name: "x",
      description: "x",
      enabled: true,
      schedule: { kind: "at", at: new Date(NOW + 600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "m", taskId: "t1" },
      delivery: { mode: "none" },
      notify: false,
      deleteAfterRun: true,
      consecutiveErrors: 0,
      createdAt: NOW,
      updatedAt: NOW,
    } as CronJob);
    await completeComputeTaskLink(
      { taskId: "t1", wakeupJobId: "wk", job },
      { taskStore: store, cron, now: () => NOW + 5000 },
    );
    expect(store.current().metadata).toMatchObject({
      computeJobs: {
        j9: {
          status: "succeeded",
          finishedAt: NOW + 5000,
          verification: "shape_only_trusted_worker",
        },
      },
    });
    expect(cron.upsertJob).toHaveBeenCalledTimes(1);
    expect(cron.jobs.get("wk")!.schedule).toEqual({
      kind: "at",
      at: new Date(NOW + 5000).toISOString(),
    });
  });

  it("is a no-op for a finished task and tolerates a missing wakeup", async () => {
    const store = fakeStore(task({ status: "completed" }));
    const cron = fakeCron();
    await completeComputeTaskLink(
      { taskId: "t1", wakeupJobId: "gone", job },
      { taskStore: store, cron, now: () => NOW },
    );
    expect(store.updates).toHaveLength(0);
    expect(cron.upsertJob).not.toHaveBeenCalled();
  });
});
