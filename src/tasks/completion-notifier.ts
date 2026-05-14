/**
 * Task completion notifier (PLAN-17 Phase 4b).
 *
 * Subscribes to `TaskStore.onChange()` and, when a task transitions to
 * a terminal status (`completed` / `failed` / `stopped`), enqueues a
 * system event into the task's owning agent session. The channel
 * monitor relays the system-event-prefixed reply to the user's
 * primary channel — no new channel-send code needed.
 *
 * Hooks the listener at gateway boot via `startCompletionNotifier()`,
 * called after `startTaskStore()` so the store exists.
 *
 * Disable with `BITTERBOT_TASKS_COMPLETION_NOTIFY=0`.
 */

import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveTaskStore, type TaskStoreEvent } from "./store.js";
import { isTerminal, type Task } from "./types.js";

const log = createSubsystemLogger("tasks/completion-notifier");

type NotifierState = {
  unsubscribe: () => void;
};

let state: NotifierState | null = null;

export function isCompletionNotifierEnabled(): boolean {
  const v = process.env.BITTERBOT_TASKS_COMPLETION_NOTIFY;
  if (v === undefined) return true;
  return v === "1" || v === "true";
}

export function startCompletionNotifier(opts?: {
  /** Test seam: override the global enqueue function. */
  enqueue?: typeof enqueueSystemEvent;
}): boolean {
  if (state) return true;
  if (!isCompletionNotifierEnabled()) return false;
  const store = getActiveTaskStore();
  if (!store) {
    log.warn("completion notifier could not start: task store is not active");
    return false;
  }
  const enqueue = opts?.enqueue ?? enqueueSystemEvent;
  const unsubscribe = store.onChange((evt) => {
    try {
      handleEvent(evt, enqueue);
    } catch (err) {
      log.warn(`completion notifier error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  state = { unsubscribe };
  log.info("task completion notifier active");
  return true;
}

export function stopCompletionNotifier(): void {
  if (!state) return;
  state.unsubscribe();
  state = null;
}

function handleEvent(evt: TaskStoreEvent, enqueue: typeof enqueueSystemEvent): void {
  if (evt.type !== "updated") return;
  const task = evt.task;
  if (!isTerminal(task.status)) return;
  if (!task.agentSessionKey) return;
  enqueue(formatNotificationText(task), {
    sessionKey: task.agentSessionKey,
    contextKey: `task-complete:${task.id}`,
  });
  log.info(`task notification enqueued task=${task.id} status=${task.status}`);
}

function formatNotificationText(task: Task): string {
  const outputClause = task.output ? ` Output: ${task.output}.` : "";
  const reasoning =
    task.metadata && typeof task.metadata.lastJudgeReasoning === "string"
      ? ` Judge: ${task.metadata.lastJudgeReasoning}`
      : "";
  return `[task ${task.status}] Task ${task.id} (${truncate(task.goal, 80)}).${outputClause}${reasoning}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
