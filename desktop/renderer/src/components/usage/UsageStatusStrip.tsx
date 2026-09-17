import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageEventRow, UsageLedgerSummary } from "../../stores/usage-store";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useModelsStore } from "../../stores/models-store";
import { useSessionsStore } from "../../stores/sessions-store";
import { formatPct } from "./usage-format";

/**
 * The always-on strip Hermes and Kilo users expect: model · context used/window · session cost ·
 * cache warm dot · current 5-hour block. Lives in the chat header; refreshes on `usage` events.
 */
export function UsageStatusStrip() {
  const sessionKey = useChatStore((s) => s.sessionKey);
  const status = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const request = useGatewayStore((s) => s.request);
  const current = useModelsStore((s) => s.sessionModels[sessionKey]);
  const catalog = useModelsStore((s) => s.catalog);
  const session = useSessionsStore((s) => s.sessions.find((e) => e.key === sessionKey));
  const [summary, setSummary] = useState<UsageLedgerSummary | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const methods = hello?.features?.methods;
  const supported = methods ? methods.includes("usage.ledger.summary") : true;

  const refresh = useCallback(async () => {
    if (status !== "connected" || !supported || !sessionKey) return;
    try {
      const res = (await request("usage.ledger.summary", {
        days: 30,
        sessionKey,
      })) as UsageLedgerSummary;
      setSummary(res);
    } catch {
      // strip is best-effort
    }
  }, [status, supported, sessionKey, request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onUsage = useCallback(
    (payload: unknown) => {
      const evt = payload as UsageEventRow;
      if (!evt || evt.sessionKey !== sessionKey) return;
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        void refresh();
      }, 1_500);
    },
    [sessionKey, refresh],
  );
  useGatewayEvent("usage", onUsage);

  const modelEntry = current
    ? catalog.find((m) => m.id === current.model && m.provider === current.provider)
    : undefined;
  const contextWindow = modelEntry?.contextWindow;
  const contextTokens =
    typeof session?.totalTokens === "number" && session.totalTokens > 0
      ? session.totalTokens
      : typeof session?.inputTokens === "number"
        ? session.inputTokens
        : undefined;
  const ctxRatio = contextWindow && contextTokens ? contextTokens / contextWindow : null;
  const ctxTone =
    ctxRatio === null
      ? "bg-muted-foreground/40"
      : ctxRatio >= 0.9
        ? "bg-danger"
        : ctxRatio >= 0.75
          ? "bg-warning"
          : "bg-success";
  const cost = summary?.totals.cost.total ?? 0;
  const warm = summary?.cacheHealth.warm ?? false;
  const block = summary?.live.window5h;

  if (!supported) return null;

  return (
    <div
      className="hidden md:flex items-center gap-3 text-2xs text-muted-foreground tabular-nums"
      title="Session cost (30d) · context used of window · cache warm/cold · current 5-hour block"
      data-testid="usage-status-strip"
    >
      {contextWindow && contextTokens !== undefined && (
        <span className="inline-flex items-center gap-1.5">
          <span className="w-16 h-1 rounded-full bg-muted/40 overflow-hidden inline-block">
            <span
              className={cn("block h-full rounded-full", ctxTone)}
              style={{ width: `${Math.min(100, (ctxRatio ?? 0) * 100)}%` }}
            />
          </span>
          {formatTokens(contextTokens)}/{formatTokens(contextWindow)}
          {ctxRatio !== null ? ` (${formatPct(ctxRatio)})` : ""}
        </span>
      )}
      {summary && (
        <>
          <span className="text-brand">{formatCost(cost)}</span>
          <span className="inline-flex items-center gap-1">
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                warm ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            {warm ? "cache warm" : "cache cold"}
          </span>
          {block && block.calls > 0 && <span>{formatCost(block.cost)} this 5h</span>}
        </>
      )}
    </div>
  );
}
