import { useState, useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { FileEdit, Plus, Minus, Columns, Rows } from "lucide-react";
import { cn } from "../../../lib/utils";
import {
  extractStrReplaceArgs,
  generateLineDiff,
  calculateDiffStats,
  type DiffLine,
} from "./tool-view-utils";

type DiffMode = "unified" | "split";

export function StrReplaceToolView({ toolCall }: ToolViewProps) {
  const [diffMode, setDiffMode] = useState<DiffMode>("unified");

  const args = toolCall.args as Record<string, unknown> | undefined;
  const isRunning = toolCall.status === "running";
  const output = toolCall.result ?? toolCall.partialResult;

  const replaceArgs = useMemo(() => extractStrReplaceArgs(args), [args]);

  const diff = useMemo(() => {
    if (!replaceArgs) return [];
    return generateLineDiff(replaceArgs.oldStr, replaceArgs.newStr);
  }, [replaceArgs]);

  const stats = useMemo(() => calculateDiffStats(diff), [diff]);

  const filePath = replaceArgs?.filePath;
  const fileName = filePath ? filePath.split("/").pop() : null;

  // If we don't have str-replace args, fall back to showing raw output
  if (!replaceArgs) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
          <FileEdit className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-medium text-zinc-300">Edit File</span>
        </div>
        <pre className="flex-1 overflow-auto p-3 bg-zinc-950/60 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-words">
          {output ?? (isRunning ? "Editing..." : "No content")}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* File header with diff stats */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50">
        <FileEdit className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-medium text-zinc-300 truncate flex-1">
          {fileName ?? "Edit"}
        </span>

        {/* Diff stats */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {stats.additions > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
              <Plus className="w-2.5 h-2.5" />
              {stats.additions}
            </span>
          )}
          {stats.deletions > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] font-semibold text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20">
              <Minus className="w-2.5 h-2.5" />
              {stats.deletions}
            </span>
          )}
        </div>

        {/* Diff mode toggle */}
        <div className="flex items-center gap-0.5 ml-1 bg-zinc-800/50 rounded p-0.5">
          <button
            onClick={() => setDiffMode("unified")}
            className={cn(
              "p-1 rounded transition-colors",
              diffMode === "unified"
                ? "bg-zinc-700/50 text-zinc-300"
                : "text-zinc-500 hover:text-zinc-400",
            )}
            title="Unified diff"
          >
            <Rows className="w-3 h-3" />
          </button>
          <button
            onClick={() => setDiffMode("split")}
            className={cn(
              "p-1 rounded transition-colors",
              diffMode === "split"
                ? "bg-zinc-700/50 text-zinc-300"
                : "text-zinc-500 hover:text-zinc-400",
            )}
            title="Split diff"
          >
            <Columns className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* File path */}
      {filePath && (
        <div className="px-3 py-1.5 bg-zinc-900/40 border-b border-zinc-800/30 font-mono text-[11px] text-zinc-400 truncate">
          {filePath}
        </div>
      )}

      {/* Diff content */}
      <div className="flex-1 overflow-auto bg-zinc-950/60">
        {isRunning && diff.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-zinc-500 text-sm animate-pulse">Applying edit...</span>
          </div>
        ) : diffMode === "unified" ? (
          <UnifiedDiff lines={diff} />
        ) : (
          <SplitDiff lines={diff} />
        )}
      </div>
    </div>
  );
}

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="font-mono text-[11px] leading-[1.5]">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex",
            line.type === "added" && "bg-emerald-500/10",
            line.type === "removed" && "bg-red-500/10",
          )}
        >
          {/* Line numbers */}
          <span className="flex-shrink-0 w-8 text-right pr-1 select-none text-zinc-600">
            {line.oldLineNum ?? ""}
          </span>
          <span className="flex-shrink-0 w-8 text-right pr-2 select-none text-zinc-600">
            {line.newLineNum ?? ""}
          </span>
          {/* Marker */}
          <span
            className={cn(
              "flex-shrink-0 w-4 text-center select-none",
              line.type === "added" && "text-emerald-400",
              line.type === "removed" && "text-red-400",
              line.type === "unchanged" && "text-zinc-600",
            )}
          >
            {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
          </span>
          {/* Content */}
          <span
            className={cn(
              "flex-1 whitespace-pre-wrap break-all pr-3",
              line.type === "added" && "text-emerald-300",
              line.type === "removed" && "text-red-300",
              line.type === "unchanged" && "text-zinc-400",
            )}
          >
            {line.content || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  // Build left (old) and right (new) columns
  const leftLines: Array<DiffLine | null> = [];
  const rightLines: Array<DiffLine | null> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === "unchanged") {
      leftLines.push(line);
      rightLines.push(line);
      i++;
    } else if (line.type === "removed") {
      // Collect consecutive removals + additions for side-by-side
      const removals: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "removed") {
        removals.push(lines[i]);
        i++;
      }
      const additions: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "added") {
        additions.push(lines[i]);
        i++;
      }
      const maxLen = Math.max(removals.length, additions.length);
      for (let j = 0; j < maxLen; j++) {
        leftLines.push(j < removals.length ? removals[j] : null);
        rightLines.push(j < additions.length ? additions[j] : null);
      }
    } else {
      // Added without corresponding removal
      leftLines.push(null);
      rightLines.push(line);
      i++;
    }
  }

  return (
    <div className="flex font-mono text-[11px] leading-[1.5]">
      {/* Left (old) */}
      <div className="flex-1 border-r border-zinc-800/50">
        {leftLines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "flex min-h-[1.5em]",
              line?.type === "removed" && "bg-red-500/10",
            )}
          >
            <span className="flex-shrink-0 w-8 text-right pr-2 select-none text-zinc-600">
              {line?.oldLineNum ?? ""}
            </span>
            <span
              className={cn(
                "flex-1 whitespace-pre-wrap break-all pr-2",
                line?.type === "removed" ? "text-red-300" : "text-zinc-400",
              )}
            >
              {line?.content ?? ""}
            </span>
          </div>
        ))}
      </div>
      {/* Right (new) */}
      <div className="flex-1">
        {rightLines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "flex min-h-[1.5em]",
              line?.type === "added" && "bg-emerald-500/10",
            )}
          >
            <span className="flex-shrink-0 w-8 text-right pr-2 select-none text-zinc-600">
              {line?.newLineNum ?? ""}
            </span>
            <span
              className={cn(
                "flex-1 whitespace-pre-wrap break-all pr-2",
                line?.type === "added" ? "text-emerald-300" : "text-zinc-400",
              )}
            >
              {line?.content ?? ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
