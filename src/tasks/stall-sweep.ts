/**
 * Finding long-running tasks that nothing will ever resume (PLAN-53 E4).
 *
 * A task that is not finished, has not been touched for a day, and has no
 * wakeup scheduled is stranded: it looks in progress and will stay that way.
 * Only the `doctor` command used to notice. The gateway now looks itself and
 * tells the owner, once per task.
 */

import { getCronEngine } from "../cron/active.js";
import { notifyOwner } from "../infra/owner-notify.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveTaskStore } from "./store.js";
import { isTerminal, type Task } from "./types.js";

const log = createSubsystemLogger("tasks");

export const TASK_STALE_MS = 24 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_SWEEP_DELAY_MS = 10 * 60_000;

const ACTIVE_STATUSES = ["pending", "planning", "running", "waiting_external", "judging"] as const;

/** Unfinished, untouched for a day, and with no wakeup that would resume it. */
export function findStrandedTasks(
  tasks: readonly Task[],
  scheduledTaskIds: ReadonlySet<string>,
  now: number,
): Task[] {
  return tasks.filter(
    (task) =>
      !isTerminal(task.status) &&
      now - task.lastSeenAt > TASK_STALE_MS &&
      !scheduledTaskIds.has(task.id),
  );
}

/** Ids of tasks an enabled cron job is going to wake. */
export function scheduledWakeupTaskIds(): Set<string> {
  const ids = new Set<string>();
  for (const job of getCronEngine()?.listJobs() ?? []) {
    const taskId = job.payload.kind === "agentTurn" ? job.payload.taskId : undefined;
    if (job.enabled && taskId) {
      ids.add(taskId);
    }
  }
  return ids;
}

const reported = new Set<string>();
let timer: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;

/** Look once. Returns the tasks newly reported to the owner. */
export function sweepStrandedTasks(now = Date.now()): Task[] {
  const store = getActiveTaskStore();
  if (!store) {
    return [];
  }
  const active = store.list({ status: [...ACTIVE_STATUSES], limit: 1000 });
  const stranded = findStrandedTasks(active, scheduledWakeupTaskIds(), now);
  // A task that moved on is forgotten, so it is reported again if it strands again.
  const strandedIds = new Set(stranded.map((t) => t.id));
  for (const id of reported) {
    if (!strandedIds.has(id)) {
      reported.delete(id);
    }
  }
  const fresh = stranded.filter((task) => !reported.has(task.id));
  if (fresh.length === 0) {
    return [];
  }
  for (const task of fresh) {
    reported.add(task.id);
  }
  const names = fresh
    .slice(0, 5)
    .map((task) => `"${task.goal.slice(0, 60)}" (${task.id})`)
    .join(", ");
  const more = fresh.length > 5 ? ` and ${fresh.length - 5} more` : "";
  log.warn(`${fresh.length} stranded task(s): ${fresh.map((t) => t.id).join(", ")}`);
  void notifyOwner({
    kind: "task-stalled",
    dedupeKey: `task-stranded:${fresh
      .map((t) => t.id)
      .join(",")
      .slice(0, 200)}`,
    text:
      `${fresh.length === 1 ? "A task has" : `${fresh.length} tasks have`} not moved for over a day and nothing is scheduled to resume ${fresh.length === 1 ? "it" : "them"}: ${names}${more}. ` +
      "Ask the agent to continue or stop them, or stop them from the Automations page.",
  }).catch((err) => log.warn(`could not report stranded tasks: ${String(err)}`));
  return fresh;
}

export function startTaskStallSweep(): void {
  stopTaskStallSweep();
  const run = () => {
    try {
      sweepStrandedTasks();
    } catch (err) {
      log.warn(`stranded-task sweep failed: ${String(err)}`);
    }
  };
  // Not at boot: the cron engine starts asynchronously, and before its
  // wakeups are loaded every parked task would look stranded.
  firstRun = setTimeout(run, FIRST_SWEEP_DELAY_MS);
  firstRun.unref?.();
  timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopTaskStallSweep(): void {
  if (firstRun) {
    clearTimeout(firstRun);
    firstRun = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function resetTaskStallSweepForTest(): void {
  stopTaskStallSweep();
  reported.clear();
}
