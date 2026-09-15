import type { UsageEventRow } from "../../stores/usage-store";
import { formatDateTime, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { formatUsdSmart, kindLabel, pricingSourceLabel, pricingSourceTone } from "./usage-format";

/** The last N ledger rows, newest first, updated as `usage` events stream in. */
export function UsageLiveFeed({
  events,
  connected,
}: {
  events: UsageEventRow[];
  connected: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/10">
        <h3 className="text-sm font-medium text-foreground">Live calls</h3>
        <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
          <span
            className={cn(
              "inline-block w-1.5 h-1.5 rounded-full",
              connected ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
          {connected ? "streaming" : "offline"}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">Waiting for the first model call…</p>
      ) : (
        <div className="max-h-[520px] overflow-y-auto">
          {events.map((e) => (
            <div
              key={e.id}
              className={cn(
                "grid grid-cols-[auto_1fr_auto] gap-3 px-4 py-2 border-b border-border/5 last:border-0 text-xs items-center",
                e.status === "error" && "bg-danger/5",
              )}
            >
              <div className="text-2xs text-muted-foreground whitespace-nowrap tabular-nums">
                {formatDateTime(e.ts)}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="rounded border border-border/20 bg-muted/30 px-1.5 text-2xs text-muted-foreground">
                    {kindLabel(e.kind)}
                  </span>
                  <span
                    className="text-foreground truncate"
                    title={`${e.provider ?? "?"}/${e.model ?? "?"}`}
                  >
                    {e.model ?? "unknown"}
                  </span>
                  <span className="text-muted-foreground/60 truncate">{e.feature}</span>
                  {e.status === "error" && <span className="text-danger">error</span>}
                  {e.batch && <span className="text-2xs text-muted-foreground">batch</span>}
                </div>
                <div className="text-2xs text-muted-foreground/60 tabular-nums">
                  in {formatTokens(e.usage.input)}
                  {e.usage.cacheRead > 0 ? ` · cache r ${formatTokens(e.usage.cacheRead)}` : ""}
                  {e.usage.cacheWrite > 0 ? ` · cache w ${formatTokens(e.usage.cacheWrite)}` : ""}
                  {e.usage.output > 0 ? ` · out ${formatTokens(e.usage.output)}` : ""}
                  {e.items ? ` · ${e.items} items` : ""}
                  {e.durationMs ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : ""}
                  {e.agentId ? ` · ${e.agentId}` : ""}
                </div>
              </div>
              <div className="text-right whitespace-nowrap">
                <div className="text-brand tabular-nums">{formatUsdSmart(e.cost.total)}</div>
                <span
                  className={cn("rounded border px-1 text-3xs", pricingSourceTone(e.costSource))}
                >
                  {pricingSourceLabel(e.costSource)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
