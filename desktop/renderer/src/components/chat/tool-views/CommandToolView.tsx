import { useEffect, useRef, useState, useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { cn } from "../../../lib/utils";
import { parseExitCode, isNonBlockingOutput, safeJsonParse } from "./tool-view-utils";

const MAX_COLLAPSED_LINES = 15;

/**
 * Terminal-style tool view for command execution tools.
 * Shows command with syntax highlighting, exit code, output truncation.
 */
export function CommandToolView({ toolCall }: ToolViewProps) {
  const outputRef = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);

  // Extract command from args
  const args = toolCall.args as Record<string, unknown> | undefined;
  const command =
    typeof args?.command === "string"
      ? args.command
      : typeof args?.cmd === "string"
        ? args.cmd
        : null;
  const sessionName =
    typeof args?.session_name === "string"
      ? args.session_name
      : typeof args?.sessionName === "string"
        ? args.sessionName
        : null;

  const rawOutput = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";

  // Process output
  const processedOutput = useMemo(() => {
    if (!rawOutput) return null;
    let text = rawOutput;
    // Unescape literal \n and \t if they look escaped
    if (text.includes("\\n") && !text.includes("\n")) {
      text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }
    // Try to pretty-print JSON output
    const trimmed = text.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 10000) {
      const parsed = safeJsonParse(trimmed, null);
      if (parsed !== null) {
        return JSON.stringify(parsed, null, 2);
      }
    }
    return text;
  }, [rawOutput]);

  // Exit code
  const exitCode = rawOutput ? parseExitCode(rawOutput) : null;

  // Non-blocking detection
  const nonBlocking = rawOutput ? isNonBlockingOutput(rawOutput) : null;

  // Line counting for truncation
  const outputLines = processedOutput?.split("\n") ?? [];
  const totalLines = outputLines.length;
  const needsTruncation = !expanded && totalLines > MAX_COLLAPSED_LINES;
  const visibleOutput = needsTruncation
    ? outputLines.slice(0, MAX_COLLAPSED_LINES).join("\n")
    : processedOutput;

  // Auto-scroll to bottom when output updates (only when not truncated/manually viewing)
  useEffect(() => {
    if (outputRef.current && (expanded || totalLines <= MAX_COLLAPSED_LINES)) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [processedOutput, expanded, totalLines]);

  return (
    <div className="flex flex-col h-full">
      {/* Terminal header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/80 border-b border-zinc-700/50">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </div>
        {sessionName && (
          <span className="text-[10px] text-zinc-500 font-mono ml-2">
            {sessionName}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Exit code badge */}
          {exitCode !== null && (
            <span
              className={cn(
                "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                exitCode === 0
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-red-500/10 text-red-400 border-red-500/20",
              )}
            >
              Exit {exitCode}
            </span>
          )}
          <span className="text-[10px] text-zinc-500 font-mono">bash</span>
        </div>
      </div>

      {/* Command line */}
      {command && (
        <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800/50 font-mono text-xs">
          <span className="text-green-400/80">$</span>{" "}
          <span className="text-zinc-200">{command}</span>
        </div>
      )}

      {/* Non-blocking info box */}
      {nonBlocking && (
        <div className="mx-3 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
          <span className="text-xs text-blue-300">
            Command sent to tmux session <span className="font-mono font-semibold">{nonBlocking.sessionName}</span>
          </span>
        </div>
      )}

      {/* Output area */}
      <pre
        ref={outputRef}
        className="flex-1 overflow-auto p-3 bg-zinc-950/80 font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-all"
      >
        {visibleOutput ? (
          visibleOutput
        ) : isRunning ? (
          <span className="text-zinc-500 animate-pulse">Executing...</span>
        ) : (
          <span className="text-zinc-600">No output</span>
        )}
        {isRunning && processedOutput && (
          <span className="inline-block w-1.5 h-3.5 bg-green-400/80 ml-0.5 animate-pulse" />
        )}
      </pre>

      {/* Show more/less toggle */}
      {totalLines > MAX_COLLAPSED_LINES && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 border-t border-zinc-800/50 bg-zinc-900/40 text-[11px] text-zinc-400 hover:text-zinc-300 hover:bg-zinc-800/40 transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3 h-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-3 h-3" />
              Show {totalLines - MAX_COLLAPSED_LINES} more lines
            </>
          )}
        </button>
      )}
    </div>
  );
}
