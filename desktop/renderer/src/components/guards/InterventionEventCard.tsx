import { useMemo } from "react";
import { cn } from "../../lib/utils";

export type InterventionFiredEvent = {
  id?: string;
  ts: number;
  sessionKey?: string;
  skill: string;
  interceptorId: string;
  toolName: string;
  intervention: {
    type: "modify" | "inject" | "require_prereq" | "block" | "noop";
    reason?: string;
    tool?: string;
    contextText?: string;
    userVisibleMessage?: string;
    newParams?: unknown;
  };
  latencyMs?: number;
};

const TYPE_COLORS: Record<InterventionFiredEvent["intervention"]["type"], string> = {
  modify: "bg-amber-500/10 text-amber-200 border-amber-500/30",
  inject: "bg-blue-500/10 text-blue-200 border-blue-500/30",
  require_prereq: "bg-purple-500/10 text-purple-200 border-purple-500/30",
  block: "bg-red-500/10 text-red-200 border-red-500/30",
  noop: "bg-slate-500/10 text-slate-300 border-slate-500/30",
};

const TYPE_LABEL: Record<InterventionFiredEvent["intervention"]["type"], string> = {
  modify: "modified",
  inject: "injected",
  require_prereq: "required prereq",
  block: "blocked",
  noop: "noop",
};

export function InterventionEventCard({ event }: { event: InterventionFiredEvent }) {
  const time = useMemo(
    () =>
      new Date(event.ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    [event.ts],
  );
  const typeClass = TYPE_COLORS[event.intervention.type];
  const typeLabel = TYPE_LABEL[event.intervention.type];

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-xs space-y-1",
        "bg-card/60 backdrop-blur-sm border-border/30",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("px-1.5 py-0.5 rounded text-badge border", typeClass)}>
          {typeLabel}
        </span>
        <span className="font-mono text-muted-foreground">{event.toolName}</span>
        <span className="text-muted-foreground/60 ml-auto tabular-nums">{time}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-foreground">{event.skill}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground font-mono text-badge">{event.interceptorId}</span>
        {typeof event.latencyMs === "number" && (
          <span className="ml-auto text-muted-foreground/60 tabular-nums">
            {event.latencyMs.toFixed(1)}ms
          </span>
        )}
      </div>
      {event.intervention.reason && (
        <div className="text-muted-foreground/80">{event.intervention.reason}</div>
      )}
      {event.intervention.type === "require_prereq" && event.intervention.tool && (
        <div className="text-purple-300/80">
          → requires <span className="font-mono">{event.intervention.tool}</span>
        </div>
      )}
      {event.intervention.type === "block" && event.intervention.userVisibleMessage && (
        <div className="text-red-300/90 italic">{event.intervention.userVisibleMessage}</div>
      )}
    </div>
  );
}
