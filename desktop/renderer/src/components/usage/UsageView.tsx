import { useCallback, useEffect } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUsageStore, type UsageResult } from "../../stores/usage-store";
import { formatTokens, formatCost } from "../../lib/format";
import { cn } from "../../lib/utils";

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

function DailyChart({ daily }: { daily: UsageResult["aggregates"]["daily"] }) {
  if (!daily || daily.length === 0) return null;
  const maxTokens = Math.max(...daily.map((d) => d.tokens), 1);

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">Daily Token Usage</h3>
      <div className="flex items-end gap-1 h-32">
        {daily.map((day) => {
          const height = Math.max(2, (day.tokens / maxTokens) * 100);
          return (
            <div
              key={day.date}
              className="flex-1 flex flex-col items-center group relative"
            >
              <div
                className="w-full bg-purple-500/40 hover:bg-purple-500/60 rounded-t transition-colors"
                style={{ height: `${height}%` }}
                title={`${day.date}: ${formatTokens(day.tokens)} tokens, ${formatCost(day.cost)}`}
              />
              {daily.length <= 14 && (
                <span className="text-[8px] text-muted-foreground/40 mt-1 rotate-[-45deg] origin-top-left whitespace-nowrap">
                  {day.date.slice(5)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ModelBreakdown({
  byModel,
}: {
  byModel: UsageResult["aggregates"]["byModel"];
}) {
  if (!byModel || byModel.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">By Model</h3>
      <div className="space-y-2">
        {byModel.slice(0, 10).map((entry, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-foreground truncate">
                {entry.model ?? "unknown"}
              </span>
              <span className="text-muted-foreground/60">
                {entry.provider ?? ""}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-muted-foreground">
                {formatTokens(entry.totals.totalTokens)}
              </span>
              <span className="text-purple-300 font-medium">
                {formatCost(entry.totals.totalCost)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionList({
  sessions,
}: {
  sessions: UsageResult["sessions"];
}) {
  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden">
      <h3 className="text-sm font-medium text-foreground px-4 py-3 border-b border-border/10">
        Sessions ({sessions.length})
      </h3>
      <div className="max-h-[300px] overflow-y-auto">
        {sessions.map((session, i) => (
          <div
            key={session.key ?? i}
            className="flex items-center justify-between px-4 py-2 border-b border-border/5 last:border-0 hover:bg-muted/20"
          >
            <div className="min-w-0 flex-1">
              <span className="text-xs text-foreground truncate block">
                {session.label ?? session.key}
              </span>
              {session.model && (
                <span className="text-[10px] text-muted-foreground/60">
                  {session.model}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0 text-xs">
              {session.usage && (
                <>
                  <span className="text-muted-foreground">
                    {formatTokens(session.usage.totalTokens)}
                  </span>
                  <span className="text-purple-300">
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

const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;

export function UsageView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const result = useUsageStore((s) => s.result);
  const days = useUsageStore((s) => s.days);
  const loading = useUsageStore((s) => s.loading);
  const setResult = useUsageStore((s) => s.setResult);
  const setDays = useUsageStore((s) => s.setDays);
  const setLoading = useUsageStore((s) => s.setLoading);
  const setError = useUsageStore((s) => s.setError);

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    try {
      const res = (await request("sessions.usage", {
        days,
        limit: 50,
      })) as UsageResult;
      setResult(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [gwStatus, request, days, setResult, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const totals = result?.totals;
  const aggregates = result?.aggregates;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Usage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {result
              ? `${result.startDate} — ${result.endDate}`
              : "Analytics & cost breakdown"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-border/20">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={cn(
                  "px-2.5 py-1 text-xs transition-colors",
                  days === d
                    ? "bg-purple-500/20 text-purple-300"
                    : "text-muted-foreground hover:bg-muted/30",
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg",
              "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
              "border border-purple-500/20 transition-colors",
              loading && "opacity-50",
            )}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Cost"
            value={formatCost(totals.totalCost)}
            sub={`${formatTokens(totals.totalTokens)} tokens`}
          />
          <StatCard
            label="Input Tokens"
            value={formatTokens(totals.input)}
            sub={formatCost(totals.inputCost)}
          />
          <StatCard
            label="Output Tokens"
            value={formatTokens(totals.output)}
            sub={formatCost(totals.outputCost)}
          />
          <StatCard
            label="Cache"
            value={formatTokens(totals.cacheRead + totals.cacheWrite)}
            sub={`R: ${formatTokens(totals.cacheRead)} / W: ${formatTokens(totals.cacheWrite)}`}
          />
        </div>
      )}

      {/* Messages */}
      {aggregates?.messages && (
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            ["Messages", aggregates.messages.total],
            ["User", aggregates.messages.user],
            ["Assistant", aggregates.messages.assistant],
            ["Tool Calls", aggregates.messages.toolCalls],
            ["Errors", aggregates.messages.errors],
            ["Tools", aggregates.tools?.uniqueTools ?? 0],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className="rounded-lg border border-border/10 bg-card/40 px-3 py-2"
            >
              <p className="text-[10px] text-muted-foreground">{label}</p>
              <p className="text-sm font-medium text-foreground">{String(value)}</p>
            </div>
          ))}
        </div>
      )}

      {/* Daily chart */}
      {aggregates?.daily && <DailyChart daily={aggregates.daily} />}

      {/* Model breakdown */}
      {aggregates?.byModel && <ModelBreakdown byModel={aggregates.byModel} />}

      {/* Session list */}
      {result?.sessions && <SessionList sessions={result.sessions} />}
    </div>
  );
}
