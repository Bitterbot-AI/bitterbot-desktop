import type { UsageResult } from "../../stores/usage-store";
import { formatCost, formatTokens } from "../../lib/format";

/** Per-session totals from the transcript scan (`sessions.usage`). */
export function UsageSessionsList({ result }: { result: UsageResult | null }) {
  const sessions = result?.sessions ?? [];
  if (sessions.length === 0) {
    return <p className="text-xs text-muted-foreground">No sessions with usage in this window.</p>;
  }
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
      <h3 className="text-sm font-medium text-foreground px-4 py-3 border-b border-border/10">
        Sessions ({sessions.length})
      </h3>
      <div className="max-h-[480px] overflow-y-auto">
        {sessions.map((session, i) => (
          <div
            key={session.key ?? i}
            className="flex items-center justify-between px-4 py-2 border-b border-border/5 last:border-0 hover:bg-muted/30"
          >
            <div className="min-w-0 flex-1">
              <span className="text-xs text-foreground truncate block">
                {session.label ?? session.key}
              </span>
              <span className="text-badge text-muted-foreground/60">
                {[session.agentId, session.channel, session.model].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 text-xs">
              {session.usage && (
                <>
                  <span className="text-muted-foreground tabular-nums">
                    {formatTokens(session.usage.totalTokens)}
                  </span>
                  <span className="text-brand tabular-nums">
                    {formatCost(session.usage.totalCost)}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
