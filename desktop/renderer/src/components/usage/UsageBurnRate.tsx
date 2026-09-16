import type { UsageLiveStats } from "../../stores/usage-store";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { formatPct } from "./usage-format";

/**
 * Burn rate and the rolling 5-hour window (the block subscription plans and ccusage watch).
 * The bar's ceiling is the busiest previous 5-hour block in the range ("-t max" in ccusage).
 */
export function UsageBurnRate({ live }: { live: UsageLiveStats }) {
  const w = live.window5h;
  const ceiling = Math.max(live.peak5h?.cost ?? 0, w.cost, 0.01);
  const ratio = w.cost / ceiling;
  const tone = ratio >= 0.9 ? "bg-danger" : ratio >= 0.7 ? "bg-warning" : "bg-success";
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Burn rate</h3>
        <span className="text-2xs text-muted-foreground">rolling 5 hours</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-2xs text-muted-foreground">last hour</p>
          <p className="text-sm font-medium text-foreground tabular-nums">
            {formatCost(live.lastHour.cost)}
          </p>
          <p className="text-2xs text-muted-foreground/60 tabular-nums">
            {formatTokens(Math.round(live.lastHour.tokensPerMinute))} tok/min
          </p>
        </div>
        <div>
          <p className="text-2xs text-muted-foreground">5h window</p>
          <p className="text-sm font-medium text-foreground tabular-nums">{formatCost(w.cost)}</p>
          <p className="text-2xs text-muted-foreground/60 tabular-nums">
            {formatCost(w.costPerHour)}/h · {w.calls} calls
          </p>
        </div>
        <div>
          <p className="text-2xs text-muted-foreground">peak 5h block</p>
          <p className="text-sm font-medium text-foreground tabular-nums">
            {live.peak5h ? formatCost(live.peak5h.cost) : "—"}
          </p>
          <p className="text-2xs text-muted-foreground/60 tabular-nums">
            {live.peak5h ? `${formatTokens(live.peak5h.tokens)} tokens` : "no history"}
          </p>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between text-2xs text-muted-foreground mb-1">
          <span>current 5h vs your busiest 5h</span>
          <span className="tabular-nums">{formatPct(ratio)}</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all", tone)}
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
