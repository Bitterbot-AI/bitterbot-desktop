import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLedgerSummary } from "../../stores/usage-store";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatCost, formatRelativeTime, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useUIStore } from "../../stores/ui-store";
import { formatPct } from "../usage/usage-format";

/**
 * The number people ask for second, after "is it healthy": what is it costing me. Today, the
 * current 5-hour block, the 30-day total, cache warm/cold, and the loudest cost-coach flag.
 * Silent on gateways without the ledger. Click-through to the Usage tab.
 */
export function SpendCard() {
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const request = useGatewayStore((s) => s.request);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const [summary, setSummary] = useState<UsageLedgerSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const methods = hello?.features?.methods;
  const supported = methods ? methods.includes("usage.ledger.summary") : true;

  const refresh = useCallback(async () => {
    if (status !== "connected" || !supported) return;
    try {
      setSummary((await request("usage.ledger.summary", { days: 30 })) as UsageLedgerSummary);
    } catch {
      // card is best-effort; the Usage tab shows errors
    }
  }, [status, supported, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onUsage = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 8_000);
  }, [refresh]);
  useGatewayEvent("usage", onUsage);

  if (!supported || !summary) return null;

  const today = summary.daily.at(-1);
  const block = summary.live.window5h;
  const warm = summary.cacheHealth.warm;
  const flag = summary.flags.find((f) => f.level === "warn") ?? summary.flags[0];
  const budget = summary.budgets.budgets.toSorted((a, b) => b.ratio - a.ratio)[0];

  return (
    <button
      type="button"
      onClick={() => setActiveTab("usage")}
      className="w-full text-left rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4 hover:bg-card/80 transition-colors"
      data-testid="overview-spend-card"
    >
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-4 flex-wrap tabular-nums">
          <span>
            <span className="text-xs text-muted-foreground mr-1.5">today</span>
            <span className="text-xl font-semibold text-brand">{formatCost(today?.cost ?? 0)}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            this 5h block <span className="text-foreground">{formatCost(block.cost)}</span>
            {block.calls > 0 ? ` · ${formatCost(block.costPerHour)}/h` : ""}
          </span>
          <span className="text-xs text-muted-foreground">
            30 days <span className="text-foreground">{formatCost(summary.totals.cost.total)}</span>{" "}
            · {formatTokens(summary.totals.usage.total)} tokens
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                warm ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            cache {warm ? "warm" : "cold"} · {formatPct(summary.cacheHealth.hitRate)} hit
          </span>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-brand">
          Usage <ArrowRight className="w-3.5 h-3.5" />
        </span>
      </div>
      {(budget || flag) && (
        <div className="mt-2 flex items-center gap-4 flex-wrap text-2xs">
          {budget && (
            <span
              className={cn(
                "tabular-nums",
                budget.exceeded
                  ? "text-danger"
                  : budget.level >= 80
                    ? "text-warning"
                    : "text-muted-foreground",
              )}
            >
              budget {budget.scope === "global" ? budget.window : budget.target}:{" "}
              {formatPct(budget.ratio)} of {formatCost(budget.limitUsd)}
            </span>
          )}
          {flag && (
            <span
              className={cn(
                "truncate",
                flag.level === "warn" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {flag.message}
            </span>
          )}
        </div>
      )}
      {summary.cacheHealth.lastChatTs && (
        <p className="mt-1 text-3xs text-muted-foreground/50">
          last model call {formatRelativeTime(summary.cacheHealth.lastChatTs)}
        </p>
      )}
    </button>
  );
}
