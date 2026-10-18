/**
 * PLAN-57 §4.5: linking a compute job to a PLAN-16 task.
 *
 * On submit from inside a task: the task goes to `waiting_external`, the job
 * id is recorded on the task, a journal event is written, and a fallback
 * cron wakeup is scheduled at the job's deadline plus a margin, exactly the
 * way `task_schedule_wakeup` does it. On completion the watcher records the
 * outcome on the task and pulls that wakeup forward to "now", so the task
 * resumes through the existing PLAN-16 path (isolated session, latest
 * handoff) without a second mechanism.
 */

import { getCronEngine } from "../../cron/active.js";
import type { CronJob } from "../../cron/types.js";
import { getActiveTaskStore } from "../../tasks/store.js";
import { isTerminal, type Task } from "../../tasks/types.js";
import type { ComputeJobSummary } from "./backend.js";

/** Soapbox jobs expire 600 s after submit; wake a little after that if nothing else did. */
export const COMPUTE_TASK_FALLBACK_WAKEUP_MS = 12 * 60_000;

export type ComputeTaskLink = {
  taskId: string;
  wakeupJobId: string | null;
};

type TaskStoreLike = Pick<NonNullable<ReturnType<typeof getActiveTaskStore>>, "get" | "update">;
type CronLike = Pick<NonNullable<ReturnType<typeof getCronEngine>>, "upsertJob">;

export type LinkDeps = {
  taskStore?: TaskStoreLike | null;
  cron?: CronLike | null;
  now?: () => number;
};

function resolveDeps(deps: LinkDeps) {
  return {
    taskStore: deps.taskStore === undefined ? getActiveTaskStore() : deps.taskStore,
    cron: deps.cron === undefined ? getCronEngine() : deps.cron,
    now: deps.now ?? (() => Date.now()),
  };
}

/**
 * Attach a just-submitted job to a task. Returns the link, or an error
 * string the tool reports (the job itself is already submitted either way).
 */
export async function linkComputeJobToTask(
  params: { taskId: string; jobId: string; workload: string; items: number; reason?: string },
  deps: LinkDeps = {},
): Promise<ComputeTaskLink | { error: string }> {
  const { taskStore, cron, now } = resolveDeps(deps);
  if (!taskStore) {
    return { error: "task store is not active" };
  }
  const task = taskStore.get(params.taskId);
  if (!task) {
    return { error: `task ${params.taskId} not found` };
  }
  if (isTerminal(task.status)) {
    return { error: `task ${params.taskId} is ${task.status}` };
  }
  const computeJobs = readComputeJobs(task);
  computeJobs[params.jobId] = {
    status: "submitted",
    workload: params.workload,
    items: params.items,
    submittedAt: now(),
  };

  let wakeupJobId: string | null = null;
  if (cron) {
    const atMs = now() + COMPUTE_TASK_FALLBACK_WAKEUP_MS;
    const job: CronJob = {
      jobId: `task-wakeup-${params.taskId}-compute-${params.jobId}`,
      name: `task wakeup: compute job ${params.jobId}`,
      description: `Resume task ${params.taskId} when compute job ${params.jobId} is done`,
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message:
          `Compute job ${params.jobId} (${params.workload}, ${params.items} items) that task ${params.taskId} was waiting on ` +
          `should be finished. Call compute job_id=${params.jobId} (result when succeeded), read the latest handoff for the task, and continue it.` +
          (params.reason ? ` Why it was submitted: ${params.reason}` : ""),
        taskId: params.taskId,
      },
      delivery: { mode: "none" },
      notify: false,
      deleteAfterRun: true,
      consecutiveErrors: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      const persisted = await cron.upsertJob(job);
      wakeupJobId = persisted.jobId;
    } catch {
      wakeupJobId = null;
    }
  }

  taskStore.update(params.taskId, {
    status: "waiting_external",
    incrementWakeup: wakeupJobId !== null,
    metadata: { ...task.metadata, computeJobs },
  });
  return { taskId: params.taskId, wakeupJobId };
}

/**
 * A linked job reached a terminal or owner-facing state: record it on the
 * task and pull the fallback wakeup forward so the task resumes now.
 */
export async function completeComputeTaskLink(
  params: { taskId: string; wakeupJobId: string | null; job: ComputeJobSummary },
  deps: LinkDeps = {},
): Promise<void> {
  const { taskStore, cron, now } = resolveDeps(deps);
  if (taskStore) {
    const task = taskStore.get(params.taskId);
    if (task && !isTerminal(task.status)) {
      const computeJobs = readComputeJobs(task);
      computeJobs[params.job.id] = {
        ...computeJobs[params.job.id],
        status: params.job.status,
        finishedAt: now(),
        ...(params.job.verification ? { verification: params.job.verification } : {}),
        ...(params.job.error ? { error: params.job.error } : {}),
      };
      taskStore.update(params.taskId, { metadata: { ...task.metadata, computeJobs } });
    }
  }
  if (cron && params.wakeupJobId) {
    try {
      const engine = cron as CronLike & {
        getJob?: (id: string) => CronJob | undefined | Promise<CronJob | undefined>;
      };
      const existing = engine.getJob ? await engine.getJob(params.wakeupJobId) : undefined;
      if (existing) {
        await cron.upsertJob({
          ...existing,
          schedule: { kind: "at", at: new Date(now()).toISOString() },
          updatedAt: now(),
        });
      }
    } catch {
      // The wakeup still fires at its original time; the system event is already queued.
    }
  }
}

function readComputeJobs(task: Task): Record<string, Record<string, unknown>> {
  const raw = task.metadata?.computeJobs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return { ...(raw as Record<string, Record<string, unknown>>) };
}
