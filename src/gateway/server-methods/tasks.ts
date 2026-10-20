/**
 * tasks.*: the long-running tasks the agent is working on (PLAN-53 E8), for
 * the Automations view. `list` needs read; `stop` needs write.
 */

import { scheduledWakeupTaskIds, TASK_STALE_MS } from "../../tasks/stall-sweep.js";
import { getActiveTaskStore } from "../../tasks/store.js";
import { isTerminal, type Task, type TaskStatus } from "../../tasks/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const ACTIVE: TaskStatus[] = ["pending", "planning", "running", "waiting_external", "judging"];

function toWire(task: Task, scheduled: ReadonlySet<string>, now: number) {
  const hasWakeup = scheduled.has(task.id);
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    source: task.source,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    lastSeenAt: task.lastSeenAt,
    completedAt: task.completedAt,
    wakeupCount: task.wakeupCount,
    hasWakeup,
    /** Unfinished, untouched for a day, and nothing scheduled to resume it. */
    stranded: !isTerminal(task.status) && now - task.lastSeenAt > TASK_STALE_MS && !hasWakeup,
    output: task.output ? task.output.slice(0, 500) : null,
  };
}

export const taskHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ params, respond }) => {
    const store = getActiveTaskStore();
    if (!store) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "the task store is not running"),
      );
      return;
    }
    const now = Date.now();
    const scheduled = scheduledWakeupTaskIds();
    const limit = typeof params.limit === "number" ? Math.max(1, Math.min(params.limit, 200)) : 50;
    const active = store.list({ status: ACTIVE, limit: 200 });
    // Finished tasks only from the last week, and only as many as asked for.
    const recent =
      params.includeFinished === false
        ? []
        : store
            .list({ sinceTs: now - 7 * 24 * 60 * 60_000, limit: 200 })
            .filter((task) => isTerminal(task.status))
            .slice(0, limit);
    respond(true, {
      active: active.map((task) => toWire(task, scheduled, now)),
      finished: recent.map((task) => toWire(task, scheduled, now)),
    });
  },

  "tasks.stop": ({ params, respond }) => {
    const store = getActiveTaskStore();
    const id = typeof params.id === "string" ? params.id.trim() : "";
    const task = id ? store?.get(id) : undefined;
    if (!store || !task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown task id"));
      return;
    }
    if (isTerminal(task.status)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "the task has already ended"),
      );
      return;
    }
    try {
      const stopped = store.update(id, { status: "stopped" });
      respond(true, toWire(stopped, new Set(), Date.now()));
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
    }
  },
};
