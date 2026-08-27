import {
  Globe,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  CheckCircle,
  AlertTriangle,
  Image,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import type { ToolViewProps } from "./ToolViewRegistry";
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
  const action = typeof args?.action === "string" ? args.action : null;

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
      <div className="flex items-center gap-1.5 px-3 py-2 bg-card/80 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-danger/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-warning/80" />
          <span className="w-2.5 h-2.5 rounded-full bg-success/80" />
        </div>
        <div className="flex items-center gap-1 ml-2 text-muted-foreground">
          <ArrowLeft className="w-3 h-3" />
          <ArrowRight className="w-3 h-3" />
          <RotateCw className={cn("w-3 h-3", isRunning && "animate-spin")} />
        </div>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 border-b border-border/30">
        <Globe className="w-3 h-3 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 text-2xs font-mono text-muted-foreground truncate">
          {url ?? "about:blank"}
        </div>
        {url && (
          <span className="text-3xs text-muted-foreground flex-shrink-0">{extractDomain(url)}</span>
        )}
      </div>

      {/* Progress bar */}
      {(isRunning || progress < 100) && progress > 0 && (
        <div className="h-0.5 bg-muted/50 overflow-hidden">
          <div
            className={cn(
              "h-full bg-info transition-all",
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
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-badge font-medium shadow-lg backdrop-blur-sm",
              isRunning
                ? "bg-info/15 text-info border border-info/20"
                : isError
                  ? "bg-danger/15 text-danger border border-danger/20"
                  : "bg-success/15 text-success border border-success/20",
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
      <div className="flex-1 overflow-auto bg-card/60 relative">
        {screenshotSrc && !imgError ? (
          <img
            src={screenshotSrc}
            alt="Browser screenshot"
            className="w-full h-auto object-contain"
            onError={() => setImgError(true)}
          />
        ) : screenshotSrc && imgError ? (
          /* Image load error fallback */
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <AlertTriangle className="w-6 h-6" />
            <span className="text-sm">Screenshot failed to load</span>
          </div>
        ) : textOutput ? (
          <pre className="p-3 font-mono text-xs text-foreground whitespace-pre-wrap break-words">
            {textOutput}
          </pre>
        ) : isRunning ? (
          /* Loading skeleton */
          <div className="p-4 space-y-3 animate-pulse">
            <div className="h-4 bg-muted/50 rounded w-3/4" />
            <div className="h-3 bg-muted/40 rounded w-full" />
            <div className="h-3 bg-muted/40 rounded w-5/6" />
            <div className="h-3 bg-muted/40 rounded w-2/3" />
            <div className="h-20 bg-muted/30 rounded mt-4" />
            <div className="h-3 bg-muted/40 rounded w-full" />
            <div className="h-3 bg-muted/40 rounded w-4/5" />
          </div>
        ) : isCompleted ? (
          /* No-screenshot completion fallback */
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-success" />
            </div>
            <span className="text-sm text-foreground font-medium">Browser action completed</span>
            {url && <span className="text-xs text-muted-foreground font-mono">{url}</span>}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No browser content
          </div>
        )}
      </div>
    </div>
  );
}
