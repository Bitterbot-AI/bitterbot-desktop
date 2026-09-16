import type { UsageGroupSummary, UsageLedgerSummary } from "../../stores/usage-store";
import { formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { formatPct, formatUsdSmart, kindLabel } from "./usage-format";

function DistributionPanel({
  title,
  groups,
  labelOf,
  hint,
}: {
  title: string;
  groups: UsageGroupSummary[];
  labelOf?: (g: UsageGroupSummary) => string;
  hint?: string;
}) {
  const total = groups.reduce((s, g) => s + g.cost.total, 0);
  const tokenTotal = groups.reduce((s, g) => s + g.usage.total, 0);
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {hint && <span className="text-2xs text-muted-foreground/60">{hint}</span>}
      </div>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing recorded.</p>
      ) : (
        <div className="space-y-2.5">
          {groups.map((g) => {
            // Share by cost when anything is priced, else by tokens (local-only nodes).
            const share =
              total > 0 ? g.cost.total / total : tokenTotal > 0 ? g.usage.total / tokenTotal : 0;
            return (
              <div key={g.key}>
                <div className="flex items-center justify-between text-xs mb-1 gap-2">
                  <span className="text-foreground truncate" title={g.key}>
                    {labelOf ? labelOf(g) : g.label}
                  </span>
                  <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                    {g.calls} calls · {formatTokens(g.usage.total)} ·{" "}
                    <span className="text-brand">{formatUsdSmart(g.cost.total)}</span>
                    {g.estimatedCalls > 0 ? " ≈" : ""}
                    {g.unpricedCalls > 0 ? <span className="text-danger"> · unpriced</span> : null}
                    {" · "}
                    {formatPct(share)}
                  </span>
                </div>
                <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      g.unpricedCalls > 0 ? "bg-danger/50" : "bg-brand/60",
                    )}
                    style={{ width: `${Math.max(1, share * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Where the tokens went: chat turns vs. the hidden lanes (embeddings, dreams, extraction, evolution…). */
export function UsageFeaturesPanel({ summary }: { summary: UsageLedgerSummary }) {
  const memoryFeatures = summary.byFeature.filter((f) => f.key.startsWith("memory/"));
  const memoryCost = memoryFeatures.reduce((s, f) => s + f.cost.total, 0);
  const memoryShare = summary.totals.cost.total > 0 ? memoryCost / summary.totals.cost.total : 0;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <p className="text-xs text-muted-foreground">
          Memory subsystem (embeddings, dreams, extraction, planner):{" "}
          <span className="text-foreground">{formatUsdSmart(memoryCost)}</span> ·{" "}
          {formatPct(memoryShare)} of spend across {memoryFeatures.reduce((s, f) => s + f.calls, 0)}{" "}
          calls.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DistributionPanel
          title="By feature"
          groups={summary.byFeature}
          hint="what the tokens were spent on"
        />
        <DistributionPanel
          title="By call type"
          groups={summary.byKind}
          labelOf={(g) => kindLabel(g.key as never)}
          hint="chat vs embeddings vs vision"
        />
        <DistributionPanel title="By provider" groups={summary.byProvider} />
        <DistributionPanel title="By agent" groups={summary.byAgent} />
        <DistributionPanel
          title="By task"
          groups={summary.byTask}
          labelOf={(g) => `${g.label} (${(g as { runs?: number }).runs ?? 0} runs)`}
          hint="long-horizon tasks, by goal"
        />
      </div>
    </div>
  );
}
