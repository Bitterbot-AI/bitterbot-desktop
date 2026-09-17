import type { UsageLedgerSummary } from "../../stores/usage-store";
import { formatCost } from "../../lib/format";
import { cn } from "../../lib/utils";
import { formatPct, formatUsdSmart } from "./usage-format";

/** Cost per verified outcome: spend divided by tasks that reached a terminal status. */
export function UsageOutcomes({ summary }: { summary: UsageLedgerSummary }) {
  const o = summary.outcomes;
  if (o.tasks === 0) {
    return (
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h3 className="text-sm font-medium text-foreground mb-1">Cost per outcome</h3>
        <p className="text-xs text-muted-foreground">
          No long-horizon tasks finished in this window. Once tasks complete or fail, spend is
          divided by verified successes here, per model and per feature.
        </p>
      </div>
    );
  }
  const failShare = o.costTotal > 0 ? o.costOnFailures / o.costTotal : 0;
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-medium text-foreground">Cost per outcome</h3>
        <span className="text-2xs text-muted-foreground">
          {o.tasks} finished task{o.tasks === 1 ? "" : "s"} · {o.succeeded} succeeded · {o.failed}{" "}
          failed · {o.stopped} stopped
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-2xs text-muted-foreground">per successful task</p>
          <p className="text-xl font-semibold text-brand tabular-nums">
            {o.costPerSuccess !== null ? formatCost(o.costPerSuccess) : "—"}
          </p>
        </div>
        <div>
          <p className="text-2xs text-muted-foreground">task spend</p>
          <p className="text-sm font-medium text-foreground tabular-nums">
            {formatCost(o.costTotal)}
          </p>
        </div>
        <div>
          <p className="text-2xs text-muted-foreground">on failed or stopped</p>
          <p
            className={cn(
              "text-sm font-medium tabular-nums",
              failShare > 0.4 ? "text-warning" : "text-foreground",
            )}
          >
            {formatCost(o.costOnFailures)} ({formatPct(failShare)})
          </p>
        </div>
      </div>
      {o.byModel.length > 0 && (
        <div className="text-2xs text-muted-foreground space-y-0.5">
          {o.byModel.slice(0, 6).map((m) => (
            <div
              key={`${m.provider}/${m.model}`}
              className="flex justify-between gap-3 tabular-nums"
            >
              <span className="truncate">
                {m.provider}/{m.model} · {m.succeeded}/{m.tasks} succeeded
              </span>
              <span>
                {m.costPerSuccess !== null
                  ? `${formatUsdSmart(m.costPerSuccess)} per success`
                  : "no successes"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
