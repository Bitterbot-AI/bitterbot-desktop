import { useCoworkStore, type CoworkTask, type TaskStatus } from "../../stores/cowork-store";
import { cn } from "../../lib/utils";
import {
  CheckCircle,
  Circle,
  Loader2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { useState, useCallback } from "react";

function getStatusIcon(status: TaskStatus) {
  switch (status) {
    case "pending":
      return <Circle className="w-3.5 h-3.5 text-zinc-500" />;
    case "running":
      return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
    case "completed":
      return <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />;
    case "error":
      return <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
  }
}

function getStatusColor(status: TaskStatus) {
  switch (status) {
    case "pending":
      return "text-zinc-500";
    case "running":
      return "text-blue-400";
    case "completed":
      return "text-emerald-400";
    case "error":
      return "text-red-400";
  }
}

function TaskNode({ task, depth = 0 }: { task: CoworkTask; depth?: number }) {
  const [expanded, setExpanded] = useState(true);
  const getChildren = useCoworkStore((s) => s.getChildren);
  const children = getChildren(task.id);
  const hasChildren = children.length > 0;

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  return (
    <div>
      <div
        className={cn(
          "flex items-start gap-2 px-3 py-1.5 hover:bg-accent/50 transition-colors rounded-md cursor-default",
          task.status === "running" && "bg-blue-500/5",
        )}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        {/* Expand toggle */}
        {hasChildren ? (
          <button
            onClick={toggle}
            className="mt-0.5 flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {/* Status icon */}
        <span className="mt-0.5 flex-shrink-0">{getStatusIcon(task.status)}</span>

        {/* Label and info */}
        <div className="flex-1 min-w-0">
          <span className={cn("text-xs font-medium", getStatusColor(task.status))}>
            {task.label}
          </span>

          {task.reasoning && (
            <p className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">
              {task.reasoning}
            </p>
          )}

          {task.error && (
            <p className="text-[10px] text-red-400/80 mt-0.5 line-clamp-2">
              {task.error}
            </p>
          )}
        </div>

        {/* Duration */}
        {task.startedAt && task.endedAt && (
          <span className="text-[10px] text-muted-foreground/40 flex-shrink-0 mt-0.5">
            {formatDuration(task.endedAt - task.startedAt)}
          </span>
        )}
      </div>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {children.map((child) => (
            <TaskNode key={child.id} task={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

export function TaskTreeView() {
  const tasks = useCoworkStore((s) => s.tasks);
  const rootTaskIds = useCoworkStore((s) => s.rootTaskIds);

  if (tasks.size === 0) {
    return null;
  }

  return (
    <div className="space-y-0.5">
      {rootTaskIds.map((id) => {
        const task = tasks.get(id);
        if (!task) return null;
        return <TaskNode key={id} task={task} />;
      })}
    </div>
  );
}
