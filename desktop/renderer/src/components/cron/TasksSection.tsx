import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "../../lib/describe-error";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";

export type TaskRow = {
  id: string;
  goal: string;
  status: string;
  lastSeenAt: number;
  hasWakeup: boolean;
  stranded: boolean;
  output: string | null;
};

/** What a task's state means to the person, not the state machine's word for it. */
export function describeTask(task: TaskRow): {
  tone: "ok" | "warn" | "bad" | "idle";
  text: string;
} {
  if (task.stranded) {
    return { tone: "bad", text: "Stuck: not moved for over a day and nothing is set to resume it" };
  }
  switch (task.status) {
    case "running":
    case "planning":
    case "judging":
      return { tone: "ok", text: "Working on it" };
    case "waiting_external":
      return task.hasWakeup
        ? { tone: "idle", text: "Paused, with a time set to pick it up again" }
        : { tone: "warn", text: "Paused, waiting for you or the agent to continue it" };
    case "completed":
      return { tone: "ok", text: "Done" };
    case "failed":
      return { tone: "bad", text: "Failed" };
    case "stopped":
      return { tone: "idle", text: "Stopped" };
    default:
      return { tone: "idle", text: "Not started" };
  }
}

const TONE = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  idle: "text-muted-foreground/60",
} as const;

/** Long-running tasks the agent is carrying (PLAN-53 E8), with a way to stop one. */
export function TasksSection() {
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const [active, setActive] = useState<TaskRow[]>([]);
  const [finished, setFinished] = useState<TaskRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    try {
      const res = (await request("tasks.list", { limit: 10 })) as {
        active?: TaskRow[];
        finished?: TaskRow[];
      };
      // Stuck first: those are the ones that need a decision.
      setActive((res?.active ?? []).toSorted((a, b) => Number(b.stranded) - Number(a.stranded)));
      setFinished(res?.finished ?? []);
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    }
  }, [status, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stop = async (id: string) => {
    try {
      await request("tasks.stop", { id });
      await refresh();
    } catch (err) {
      toast.error("Could not stop the task", { description: describeError(err) });
    }
  };

  if (unavailable) return null;

  const row = (task: TaskRow, canStop: boolean) => {
    const state = describeTask(task);
    return (
      <div key={task.id} className="rounded-xl border border-border/20 bg-card/60 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-foreground line-clamp-2 break-words">{task.goal}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs">
              <span className={cn(TONE[state.tone])}>{state.text}</span>
              <span className="text-muted-foreground/60">
                Last activity {formatRelativeTime(task.lastSeenAt)}
              </span>
              <span className="font-mono text-muted-foreground/40">{task.id}</span>
            </div>
          </div>
          {canStop && (
            <button
              onClick={() => void stop(task.id)}
              className="px-2 py-1 text-xs rounded bg-danger/10 text-danger hover:bg-danger/30 border border-danger/20 flex-shrink-0"
            >
              Stop
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-3" data-testid="tasks-section">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Tasks</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Longer pieces of work your agent is carrying across conversations.
        </p>
      </div>
      {active.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60">
          Nothing in progress
        </div>
      ) : (
        active.map((task) => row(task, true))
      )}
      {finished.length > 0 && (
        <details>
          <summary className="text-xs text-muted-foreground cursor-pointer">
            Finished in the last week ({finished.length})
          </summary>
          <div className="space-y-3 mt-3">{finished.map((task) => row(task, false))}</div>
        </details>
      )}
    </section>
  );
}
