import { useState, useEffect, useRef } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
import { Globe, ArrowLeft, ArrowRight, RotateCw, CheckCircle, AlertTriangle, Image } from "lucide-react";
import { cn } from "../../../lib/utils";
import { extractScreenshot, extractDomain } from "./tool-view-utils";

export function BrowserToolView({ toolCall }: ToolViewProps) {
  const args = toolCall.args as Record<string, unknown> | undefined;
  const url =
    typeof args?.url === "string"
      ? args.url
      : typeof args?.target_url === "string"
        ? args.target_url
        : null;
  const action =
    typeof args?.action === "string" ? args.action : null;

  const output = toolCall.result ?? toolCall.partialResult;
  const isRunning = toolCall.status === "running";
  const isError = toolCall.status === "error";
  const isCompleted = toolCall.status === "completed";

  // Progress bar state
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isRunning) {
      setProgress(0);
      const startTime = Date.now();
      progressRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime;
        // Ease towards 95% over ~25 seconds
        const p = Math.min(95, (elapsed / 25000) * 95);
        setProgress(p);
      }, 200);
    } else {
      if (progressRef.current) clearInterval(progressRef.current);
      if (isCompleted) setProgress(100);
    }
    return () => {
      if (progressRef.current) clearInterval(progressRef.current);
    };
  }, [isRunning, isCompleted]);

  // Screenshot extraction
  let screenshotSrc: string | null = null;
  let textOutput = output;
  const [imgError, setImgError] = useState(false);

  if (output) {
    const extracted = extractScreenshot(output);
    if (extracted) {
      screenshotSrc = extracted.src;
      textOutput = extracted.remaining;
    }
  }

  const actionLabel = action
    ? `${action.charAt(0).toUpperCase()}${action.slice(1).replace(/[_-]/g, " ")}`
    : null;

  return (
    <div className="flex flex-col h-full">
      {/* Browser chrome */}
      <div className="flex items-center gap-1.5 px-3 py-2 bg-zinc-900/80 border-b border-zinc-700/50">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
        </div>
        <div className="flex items-center gap-1 ml-2 text-zinc-500">
          <ArrowLeft className="w-3 h-3" />
          <ArrowRight className="w-3 h-3" />
          <RotateCw className={cn("w-3 h-3", isRunning && "animate-spin")} />
        </div>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 border-b border-zinc-700/30">
        <Globe className="w-3 h-3 text-zinc-500 flex-shrink-0" />
        <div className="flex-1 text-[11px] font-mono text-zinc-400 truncate">
          {url ?? "about:blank"}
        </div>
        {url && (
          <span className="text-[9px] text-zinc-600 flex-shrink-0">
            {extractDomain(url)}
          </span>
        )}
      </div>

      {/* Progress bar */}
      {(isRunning || progress < 100) && progress > 0 && (
        <div className="h-0.5 bg-zinc-800/50 overflow-hidden">
          <div
            className={cn(
              "h-full bg-blue-400 transition-all",
              isRunning ? "duration-200" : "duration-300",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Action status badge */}
      {actionLabel && (
        <div className="absolute top-[90px] right-3 z-10">
          <div
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium shadow-lg backdrop-blur-sm",
              isRunning
                ? "bg-blue-500/15 text-blue-400 border border-blue-500/20"
                : isError
                  ? "bg-red-500/15 text-red-400 border border-red-500/20"
                  : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20",
            )}
          >
            {isRunning ? (
              <RotateCw className="w-2.5 h-2.5 animate-spin" />
            ) : isError ? (
              <AlertTriangle className="w-2.5 h-2.5" />
            ) : (
              <CheckCircle className="w-2.5 h-2.5" />
            )}
            {actionLabel} {isRunning ? "in progress" : isError ? "failed" : "completed"}
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-auto bg-zinc-950/60 relative">
        {screenshotSrc && !imgError ? (
          <img
            src={screenshotSrc}
            alt="Browser screenshot"
            className="w-full h-auto object-contain"
            onError={() => setImgError(true)}
          />
        ) : screenshotSrc && imgError ? (
          /* Image load error fallback */
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-500">
            <AlertTriangle className="w-6 h-6" />
            <span className="text-sm">Screenshot failed to load</span>
          </div>
        ) : textOutput ? (
          <pre className="p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap break-words">
            {textOutput}
          </pre>
        ) : isRunning ? (
          /* Loading skeleton */
          <div className="p-4 space-y-3 animate-pulse">
            <div className="h-4 bg-zinc-800/50 rounded w-3/4" />
            <div className="h-3 bg-zinc-800/40 rounded w-full" />
            <div className="h-3 bg-zinc-800/40 rounded w-5/6" />
            <div className="h-3 bg-zinc-800/40 rounded w-2/3" />
            <div className="h-20 bg-zinc-800/30 rounded mt-4" />
            <div className="h-3 bg-zinc-800/40 rounded w-full" />
            <div className="h-3 bg-zinc-800/40 rounded w-4/5" />
          </div>
        ) : isCompleted ? (
          /* No-screenshot completion fallback */
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-12 h-12 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-emerald-400" />
            </div>
            <span className="text-sm text-zinc-300 font-medium">Browser action completed</span>
            {url && (
              <span className="text-xs text-zinc-500 font-mono">{url}</span>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
            No browser content
          </div>
        )}
      </div>
    </div>
  );
}
