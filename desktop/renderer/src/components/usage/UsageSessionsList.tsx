import type { UsageSessionSummary } from "../../stores/usage-store";
import { formatCost, formatRelativeTime, formatTokens } from "../../lib/format";
import { formatPct } from "./usage-format";

/** Per-session totals from the ledger (same source as every other tab, so the numbers agree). */
export function UsageSessionsList({ sessions }: { sessions: UsageSessionSummary[] }) {
  if (sessions.length === 0) {
    return <p className="text-xs text-muted-foreground">No sessions with usage in this window.</p>;
  }
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
      <h3 className="text-sm font-medium text-foreground px-4 py-3 border-b border-border/10">
        Sessions ({sessions.length})
      </h3>
      <div className="max-h-[520px] overflow-y-auto">
        {sessions.map((s) => (
          <div
            key={s.sessionKey}
            className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/5 last:border-0 hover:bg-muted/30"
          >
            <div className="min-w-0 flex-1">
              <span className="text-xs text-foreground truncate block" title={s.sessionKey}>
                {s.label}
              </span>
              <span className="text-badge text-muted-foreground/60 truncate block">
                {[s.agentId, s.channel, s.models.slice(0, 2).join(", ")]
                  .filter(Boolean)
                  .join(" · ")}
                {s.lastTs ? ` · ${formatRelativeTime(s.lastTs)}` : ""}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 text-xs tabular-nums">
              <span className="text-muted-foreground/60">{s.calls} calls</span>
              <span className="text-muted-foreground" title="cache hit rate">
                {formatPct(s.cacheHitRate)}
              </span>
              <span className="text-muted-foreground">{formatTokens(s.usage.total)}</span>
              <span className="text-brand">{formatCost(s.cost.total)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
