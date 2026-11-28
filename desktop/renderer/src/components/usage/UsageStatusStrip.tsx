import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatCost, formatTokens } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useChatStore } from "../../stores/chat-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { useModelsStore } from "../../stores/models-store";
import { useSessionsStore } from "../../stores/sessions-store";
import { useUIStore } from "../../stores/ui-store";
import type { UsageEventRow, UsageLedgerSummary } from "../../stores/usage-store";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { formatPct } from "./usage-format";

/**
 * The Usage button in the chat header. It opens this conversation's context
 * use, cost, cache state and current 5-hour block, and refreshes on `usage`
 * events. Near the context limit the button itself says so.
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
      ? "bg-ink-muted"
      : ctxRatio >= 0.9
        ? "bg-danger"
        : ctxRatio >= 0.75
          ? "bg-warning"
          : "bg-success";
  const cost = summary?.totals.cost.total ?? 0;
  const warm = summary?.cacheHealth.warm ?? false;
  const block = summary?.live.window5h;

  if (!supported) return null;

  const hasContext = Boolean(contextWindow) && contextTokens !== undefined;
  // A conversation close to its context limit says so on the button itself.
  const nearLimit = ctxRatio !== null && ctxRatio >= 0.75;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="usage-status-strip"
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-ink-secondary transition-colors hover:bg-hover hover:text-ink"
        >
          {nearLimit && (
            <span
              className={cn("size-2 rounded-full", ctxRatio >= 0.9 ? "bg-danger" : "bg-warning")}
            />
          )}
          {nearLimit ? `Context ${formatPct(ctxRatio)}` : "Usage"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 text-sm">
        <dl className="space-y-2 tabular-nums">
          <Row label="Context">
            {hasContext ? (
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-1 w-12 overflow-hidden rounded-full bg-subtle">
                  <span
                    className={cn("block h-full rounded-full", ctxTone)}
                    style={{ width: `${Math.min(100, (ctxRatio ?? 0) * 100)}%` }}
                  />
                </span>
                {formatTokens(contextTokens ?? 0)} of {formatTokens(contextWindow ?? 0)}
              </span>
            ) : (
              "Unavailable"
            )}
          </Row>
          <Row label="This conversation, 30 days">{summary ? formatCost(cost) : "Unavailable"}</Row>
          {summary && <Row label="Prompt cache">{warm ? "Warm" : "Cold"}</Row>}
          {block && block.calls > 0 && (
            <Row label="Current 5-hour block">{formatCost(block.cost)}</Row>
          )}
        </dl>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveTab("usage")}
          className="mt-3 text-sm text-link hover:underline"
        >
          Open usage and budgets
        </button>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
