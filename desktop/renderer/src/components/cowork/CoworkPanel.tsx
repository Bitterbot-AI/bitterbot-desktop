import { ListTree } from "lucide-react";
import { useCoworkStore } from "../../stores/cowork-store";
import { TaskTreeView } from "./TaskTreeView";

/**
 * Cowork panel showing hierarchical task tree with sub-task progress.
 * Displayed as a tab in the right panel alongside Tools and Artifacts.
 */
export function CoworkPanel() {
  const taskCount = useCoworkStore((s) => s.tasks.size);
  const runningCount = useCoworkStore(
    (s) => [...s.tasks.values()].filter((t) => t.status === "running").length,
  );
  const completedCount = useCoworkStore(
    (s) => [...s.tasks.values()].filter((t) => t.status === "completed").length,
  );

  if (taskCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2 text-muted-foreground">
          <ListTree className="w-8 h-8 mx-auto opacity-50" />
          <p className="text-sm">No tasks yet</p>
          <p className="text-xs">Sub-agent tasks will appear here during complex operations.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border/20 flex-shrink-0">
        <span className="text-xs text-muted-foreground">
          {taskCount} task{taskCount !== 1 ? "s" : ""}
        </span>
        {runningCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            {runningCount} running
          </span>
        )}
        {completedCount > 0 && (
          <span className="text-[10px] text-emerald-400/70">{completedCount} done</span>
        )}
      </div>

      {/* Task tree */}
      <div className="flex-1 overflow-auto py-1">
        <TaskTreeView />
      </div>
    </div>
  );
}
