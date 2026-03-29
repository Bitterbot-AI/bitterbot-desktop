import { useMemo } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { cn } from "../../../lib/utils";
import {
  MessageCircleQuestion,
  FileText,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { safeJsonParse } from "./tool-view-utils";

/**
 * Dedicated view for the `ask` tool — shows the agent's question
 * and any file attachments, with a clear "awaiting input" status.
 */
export function AskToolView({ toolCall }: ToolViewProps) {
  const isRunning = toolCall.status === "running";
  const isError = toolCall.status === "error";
  const isDone = toolCall.status === "completed";

  // Extract question text and attachments
  const { question, attachments } = useMemo(() => {
    const args = toolCall.args as Record<string, unknown> | undefined;
    let question = "";
    let attachments: string[] = [];

    if (args) {
      if (typeof args.text === "string") question = args.text;
      if (typeof args.question === "string") question = args.question;
      if (Array.isArray(args.attachments))
        attachments = args.attachments.filter(
          (a): a is string => typeof a === "string",
        );
      // Single attachment string
      if (typeof args.attachments === "string")
        attachments = [args.attachments];
    }

    // Try result for more data
    const raw = toolCall.result ?? toolCall.partialResult;
    if (raw) {
      const parsed = safeJsonParse(raw, null);
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (typeof p.text === "string" && p.text && !question) question = p.text;
      }
    }

    return { question, attachments };
  }, [toolCall.args, toolCall.result, toolCall.partialResult]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b bg-gradient-to-r from-blue-500/10 to-blue-600/5 border-blue-500/20">
        <div className="w-8 h-8 rounded-lg bg-blue-500/15 flex items-center justify-center">
          <MessageCircleQuestion className="w-4 h-4 text-blue-400" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-blue-300">
            {isDone ? "Question Answered" : "Waiting for Input"}
          </h3>
        </div>
        <span
          className={cn(
            "flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full",
            isRunning
              ? "bg-amber-500/10 text-amber-400"
              : isDone
                ? "bg-emerald-500/10 text-emerald-400"
                : "bg-red-500/10 text-red-400",
          )}
        >
          {isRunning ? (
            <>
              <Clock className="w-2.5 h-2.5" />
              Awaiting
            </>
          ) : isDone ? (
            <>
              <CheckCircle2 className="w-2.5 h-2.5" />
              Answered
            </>
          ) : (
            "Error"
          )}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Question */}
        {question && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
              Question
            </span>
            <div className="rounded-lg bg-zinc-900/50 border border-zinc-800/30 p-3">
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {question}
              </p>
            </div>
          </div>
        )}

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
              Attachments
            </span>
            <div className="space-y-1.5">
              {attachments.map((filePath, i) => {
                const fileName = filePath.split("/").pop() ?? filePath;
                return (
                  <div
                    key={i}
                    className="flex items-center gap-2 rounded-lg bg-zinc-900/50 border border-zinc-800/30 px-3 py-2"
                  >
                    <FileText className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-zinc-300 font-medium truncate">
                        {fileName}
                      </div>
                      <div className="text-[10px] text-zinc-500 font-mono truncate">
                        {filePath}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Waiting animation */}
        {isRunning && !question && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <MessageCircleQuestion className="w-10 h-10 text-blue-400/60 animate-pulse" />
            <p className="mt-3 text-sm text-zinc-400">
              Waiting for the agent to formulate a question...
            </p>
          </div>
        )}

        {/* Response (from result) */}
        {isDone && toolCall.result && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold">
              Response
            </span>
            <div className="rounded-lg bg-zinc-900/50 border border-emerald-800/30 p-3">
              <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {toolCall.result}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border/20 flex-shrink-0">
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full border bg-blue-500/10 text-blue-400 border-blue-500/20">
          User Interaction
        </span>
        {toolCall.timestamp && (
          <span className="text-[10px] text-muted-foreground/60">
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
