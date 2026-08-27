import { CheckCircle2, Trophy, FileText, Sparkles, AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { cn } from "../../../lib/utils";
import { Markdown } from "../../ui/markdown";
import { safeJsonParse } from "./tool-view-utils";

/**
 * Completion ceremony view for the `complete` tool.
 * Shows summary, task checklist, file attachments, and status.
 */
export function CompleteToolView({ toolCall }: ToolViewProps) {
  const isRunning = toolCall.status === "running";
  const isError = toolCall.status === "error";

  // Extract data from tool args and result
  const { summary, tasksCompleted, attachments } = useMemo(() => {
    const args = toolCall.args as Record<string, unknown> | undefined;
    let summary = "";
    let tasksCompleted: string[] = [];
    let attachments: string[] = [];

    // Try from args first
    if (args) {
      if (typeof args.summary === "string") summary = args.summary;
      if (Array.isArray(args.tasks_completed))
        tasksCompleted = args.tasks_completed.filter((t): t is string => typeof t === "string");
      if (Array.isArray(args.tasksCompleted))
        tasksCompleted = args.tasksCompleted.filter((t): t is string => typeof t === "string");
      if (Array.isArray(args.attachments))
        attachments = args.attachments.filter((a): a is string => typeof a === "string");
    }

    // Try from result (may have richer data)
    const raw = toolCall.result ?? toolCall.partialResult;
    if (raw) {
      const parsed = safeJsonParse(raw, null);
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (typeof p.summary === "string" && p.summary) summary = p.summary;
        if (Array.isArray(p.tasks_completed) && p.tasks_completed.length > 0)
          tasksCompleted = p.tasks_completed.filter(
            (t: unknown): t is string => typeof t === "string",
          );
        if (Array.isArray(p.attachments) && p.attachments.length > 0)
          attachments = p.attachments.filter((a: unknown): a is string => typeof a === "string");
      }
    }

    return { summary, tasksCompleted, attachments };
  }, [toolCall.args, toolCall.result, toolCall.partialResult]);

  const hasContent = summary || tasksCompleted.length > 0 || attachments.length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2.5 px-4 py-3 border-b",
          isError
            ? "bg-gradient-to-r from-danger/10 to-danger/5 border-danger/20"
            : "bg-gradient-to-r from-success/10 to-success/5 border-success/20",
        )}
      >
        <div
          className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center",
            isError ? "bg-danger/15" : "bg-success/15",
          )}
        >
          {isError ? (
            <AlertTriangle className="w-4 h-4 text-danger" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-success" />
          )}
        </div>
        <div className="flex-1">
          <h3 className={cn("text-sm font-semibold", isError ? "text-danger" : "text-success")}>
            {isError ? "Task Failed" : "Task Complete"}
          </h3>
        </div>
        <span
          className={cn(
            "text-badge uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full",
            isRunning
              ? "bg-warning/10 text-warning"
              : isError
                ? "bg-danger/10 text-danger"
                : "bg-success/10 text-success",
          )}
        >
          {isRunning ? "In Progress" : isError ? "Error" : "Complete"}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Progress indicator during streaming */}
        {isRunning && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              Completing tasks...
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-success to-success transition-all duration-1000"
                style={{ width: "85%" }}
              />
            </div>
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div className="space-y-1.5">
            <span className="text-badge text-muted-foreground uppercase tracking-wider font-semibold">
              Summary
            </span>
            <div className="rounded-lg bg-card/50 border border-border/30 p-3">
              <div className="prose prose-sm prose-invert max-w-none text-foreground">
                <Markdown>{summary}</Markdown>
              </div>
            </div>
          </div>
        )}

        {/* Tasks Completed */}
        {tasksCompleted.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-badge text-muted-foreground uppercase tracking-wider font-semibold">
              Tasks Completed
            </span>
            <div className="rounded-lg bg-card/50 border border-border/30 p-3 space-y-2">
              {tasksCompleted.map((task, i) => (
                <div key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                  <span className="text-sm text-foreground">{task}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-badge text-muted-foreground uppercase tracking-wider font-semibold">
              Attachments
            </span>
            <div className="space-y-1.5">
              {attachments.map((filePath, i) => {
                const fileName = filePath.split("/").pop() ?? filePath;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-lg bg-card/50 border border-border/30 px-3 py-2"
                  >
                    <FileText className="w-4 h-4 text-info flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground font-medium truncate">{fileName}</div>
                      <div className="text-badge text-muted-foreground font-mono truncate">
                        {filePath}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state — trophy animation */}
        {!hasContent && !isRunning && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="relative">
              <Trophy className="w-12 h-12 text-warning/80" />
              <Sparkles className="w-5 h-5 text-warning absolute -top-1 -right-1 animate-pulse" />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">All tasks completed!</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border/20 flex-shrink-0">
        <span
          className={cn(
            "text-badge font-medium px-2 py-0.5 rounded-full border",
            isError
              ? "bg-danger/10 text-danger border-danger/20"
              : "bg-success/10 text-success border-success/20",
          )}
        >
          Task Completion
        </span>
        {toolCall.timestamp && (
          <span className="text-badge text-muted-foreground/60">
            {new Date(toolCall.timestamp).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
