import { AlertTriangle, Info } from "lucide-react";
import type { UsageLedgerSummary } from "../../stores/usage-store";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { DailyStackedChart } from "./DailyStackedChart";
import { budgetTone, formatPct, formatResetIn, formatUsdSmart, kindLabel } from "./usage-format";

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn("text-xl font-semibold", tone ?? "text-foreground")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

function BudgetBars({ budgets }: { budgets: UsageLedgerSummary["budgets"] }) {
  if (budgets.budgets.length === 0) {
    return (
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h3 className="text-sm font-medium text-foreground mb-1">Budgets</h3>
        <p className="text-xs text-muted-foreground">
          No spend budgets set. Add <code className="text-2xs">usage.budgets.daily.usd</code> (or
          weekly / monthly / perModel / perFeature) in Settings to get 50 / 80 / 95 / 100% alerts
          here and in the log.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Budgets</h3>
        <span className="text-2xs text-muted-foreground">
          {budgets.mode === "enforce"
            ? "enforce: background lanes pause when exceeded"
            : "warn only"}
          {budgets.backgroundPaused ? " · background paused" : ""}
        </span>
      </div>
      {budgets.budgets.map((b) => (
        <div key={b.id}>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-foreground">
              {b.scope === "global" ? b.window : `${b.target} · ${b.window}`}
            </span>
            <span
              className={cn(
                "tabular-nums",
                b.exceeded
                  ? "text-danger"
                  : b.level >= 80
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              {formatCost(b.spentUsd)} / {formatCost(b.limitUsd)} · {formatPct(b.ratio)} ·{" "}
              {formatResetIn(b.resetsAtMs)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", budgetTone(b.level, b.exceeded))}
              style={{ width: `${Math.min(100, b.ratio * 100)}%` }}
            />
          </div>
          {b.projectedUsd > b.limitUsd && !b.exceeded && (
            <p className="text-2xs text-warning mt-1">
              On pace for {formatCost(b.projectedUsd)} by reset
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function KindStrip({ byKind }: { byKind: UsageLedgerSummary["byKind"] }) {
  const total = byKind.reduce((s, k) => s + k.cost.total, 0);
  if (byKind.length === 0) return null;
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">Cost by call type</h3>
      <div className="space-y-2">
        {byKind.map((k) => {
          const share = total > 0 ? k.cost.total / total : 0;
          return (
            <div key={k.key}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-foreground">
                  {kindLabel(k.key as never)}
                  <span className="text-muted-foreground/60 ml-2">
                    {k.calls} calls · {formatTokens(k.usage.total)} tokens
                    {k.estimatedCalls > 0 ? " · ≈" : ""}
                  </span>
                </span>
                <span className="text-brand tabular-nums">{formatUsdSmart(k.cost.total)}</span>
              </div>
              <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                <div
                  className="h-full rounded-full bg-brand/60"
                  style={{ width: `${Math.max(1, share * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Flags({ flags }: { flags: UsageLedgerSummary["flags"] }) {
  if (flags.length === 0) return null;
  return (
    <div className="space-y-2">
      {flags.map((f) => (
        <div
          key={f.id}
          className={cn(
            "rounded-xl border p-3 text-xs flex gap-2",
            f.level === "warn" ? "border-warning/30 bg-warning/5" : "border-info/30 bg-info/5",
          )}
        >
          {f.level === "warn" ? (
            <AlertTriangle className="w-3.5 h-3.5 text-warning flex-shrink-0 mt-0.5" />
          ) : (
            <Info className="w-3.5 h-3.5 text-info flex-shrink-0 mt-0.5" />
          )}
          <div>
            <p className="text-foreground">{f.message}</p>
            {f.tip && <p className="text-muted-foreground mt-0.5">{f.tip}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function UsageOverview({ summary }: { summary: UsageLedgerSummary }) {
  const t = summary.totals;
  const embeddings = summary.byKind.find((k) => k.key === "embedding");
  const activeDays = Math.max(1, summary.daily.filter((d) => d.calls > 0).length);
  const perDay = t.cost.total / activeDays;
  const promptTokens = t.usage.input + t.usage.cacheRead + t.usage.cacheWrite;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          label="Total cost"
          value={formatCost(t.cost.total)}
          sub={`${t.calls} calls · ${t.errors} errors`}
          tone="text-brand"
        />
        <StatCard
          label="Tokens"
          value={formatTokens(t.usage.total)}
          sub={`in ${formatTokens(t.usage.input)} · out ${formatTokens(t.usage.output)}`}
        />
        <StatCard
          label="Cache hit rate"
          value={formatPct(t.cacheHitRate)}
          sub={`read ${formatTokens(t.usage.cacheRead)} · write ${formatTokens(t.usage.cacheWrite)} of ${formatTokens(promptTokens)} prompt`}
          tone={
            t.cacheHitRate >= 0.5
              ? "text-success"
              : promptTokens > 200_000 && t.cacheHitRate < 0.3
                ? "text-warning"
                : undefined
          }
        />
        <StatCard
          label="Embeddings"
          value={embeddings ? formatUsdSmart(embeddings.cost.total) : "$0.00"}
          sub={
            embeddings
              ? `${formatTokens(embeddings.usage.total)} tokens · ${embeddings.calls} calls${embeddings.estimatedCalls > 0 ? " · ≈" : ""}`
              : "none recorded"
          }
        />
        <StatCard
          label="Avg cost / active day"
          value={formatCost(perDay)}
          sub={`${activeDays} active of ${summary.days} days`}
        />
        <StatCard
          label="Cost split"
          value={`${formatPct(t.cost.total > 0 ? t.cost.output / t.cost.total : 0)} out`}
          sub={`in ${formatCost(t.cost.input)} · cache ${formatCost(t.cost.cacheRead + t.cost.cacheWrite)}`}
        />
      </div>

      <Flags flags={summary.flags} />

      <DailyStackedChart daily={summary.daily} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BudgetBars budgets={summary.budgets} />
        <KindStrip byKind={summary.byKind} />
      </div>
    </div>
  );
}
