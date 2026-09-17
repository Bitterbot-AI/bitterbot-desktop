import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useGatewayEvent } from "../../hooks/useGatewayEvent";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import {
  useUsageStore,
  type UsageEventRow,
  type UsageLedgerSummary,
  type UsageTab,
} from "../../stores/usage-store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { UsageFeaturesPanel } from "./UsageFeaturesPanel";
import { UsageLiveFeed } from "./UsageLiveFeed";
import { UsageModelsTable } from "./UsageModelsTable";
import { UsageOverview } from "./UsageOverview";
import { UsageSessionsList } from "./UsageSessionsList";
import { UsageWhatIf } from "./UsageWhatIf";

const DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
/** A streamed usage event schedules one summary refresh at most this often. */
const LIVE_REFRESH_MS = 8_000;

const TABS: Array<{ id: UsageTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "features", label: "Features" },
  { id: "sessions", label: "Sessions" },
  { id: "live", label: "Live" },
];

function EmptyState({ ledgerSupported }: { ledgerSupported: boolean | null }) {
  return (
    <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-6 text-sm text-muted-foreground space-y-2">
      <p className="text-foreground font-medium">No model calls in this window yet.</p>
      {ledgerSupported === false ? (
        <p>
          This gateway predates the usage ledger. Update the node to see per-model, per-feature and
          embedding usage.
        </p>
      ) : (
        <p>
          The ledger records every chat turn, hidden LLM lane (dreams, extraction, skill evolution)
          and embedding call as it happens, and imports past session transcripts in the background
          within minutes of gateway start.
        </p>
      )}
    </div>
  );
}

export function UsageView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const hello = useGatewayStore((s) => s.hello);
  const request = useGatewayStore((s) => s.request);
  const summary = useUsageStore((s) => s.summary);
  const liveEvents = useUsageStore((s) => s.liveEvents);
  const days = useUsageStore((s) => s.days);
  const tab = useUsageStore((s) => s.tab);
  const loading = useUsageStore((s) => s.loading);
  const error = useUsageStore((s) => s.error);
  const ledgerSupported = useUsageStore((s) => s.ledgerSupported);
  const lastEventAt = useUsageStore((s) => s.lastEventAt);
  const setSummary = useUsageStore((s) => s.setSummary);
  const setLiveEvents = useUsageStore((s) => s.setLiveEvents);
  const pushLiveEvent = useUsageStore((s) => s.pushLiveEvent);
  const setDays = useUsageStore((s) => s.setDays);
  const setTab = useUsageStore((s) => s.setTab);
  const setLoading = useUsageStore((s) => s.setLoading);
  const setError = useUsageStore((s) => s.setError);
  const setLedgerSupported = useUsageStore((s) => s.setLedgerSupported);

  const methods = hello?.features?.methods;
  const ledgerAvailable = methods ? methods.includes("usage.ledger.summary") : true;

  const refresh = useCallback(async () => {
    if (gwStatus !== "connected") return;
    setLoading(true);
    const errors: string[] = [];
    const [summaryRes] = await Promise.allSettled([
      ledgerAvailable
        ? (request("usage.ledger.summary", { days }) as Promise<UsageLedgerSummary>)
        : Promise.reject(new Error("usage ledger unavailable on this gateway")),
    ]);
    if (summaryRes.status === "fulfilled") {
      setSummary(summaryRes.value);
      setLedgerSupported(true);
    } else {
      setLedgerSupported(ledgerAvailable ? null : false);
      errors.push(
        summaryRes.reason instanceof Error
          ? summaryRes.reason.message
          : "Failed to load usage ledger",
      );
    }
    if (ledgerAvailable) {
      try {
        const page = (await request("usage.ledger.events", { limit: 50 })) as {
          events: UsageEventRow[];
        };
        // Merge by id so a refresh never shrinks a feed that already streamed more rows.
        const current = useUsageStore.getState().liveEvents;
        const seen = new Set(current.map((e) => e.id));
        const merged = [...current, ...(page.events ?? []).filter((e) => !seen.has(e.id))].toSorted(
          (a, b) => b.id - a.id,
        );
        setLiveEvents(merged);
      } catch {
        // live feed is best-effort
      }
    }
    setError(errors.length > 0 ? errors.join(" · ") : null);
    setLoading(false);
  }, [
    gwStatus,
    request,
    days,
    ledgerAvailable,
    setSummary,
    setLiveEvents,
    setLoading,
    setError,
    setLedgerSupported,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Streamed rows update the live feed immediately and coalesce into one summary refresh.
  // The timer calls the LATEST refresh (via ref) so a day-chip change inside the window wins.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUsageEvent = useCallback(
    (payload: unknown) => {
      const evt = payload as UsageEventRow;
      if (!evt || typeof evt.id !== "number") return;
      pushLiveEvent(evt);
      if (!refreshTimer.current) {
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          void refreshRef.current();
        }, LIVE_REFRESH_MS);
      }
    },
    [pushLiveEvent],
  );
  useGatewayEvent("usage", onUsageEvent);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const hasData = (summary?.totals.calls ?? 0) > 0;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Usage</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {summary
              ? `${summary.startDate} — ${summary.endDate}`
              : "Tokens and cost per model, feature and day"}
            {lastEventAt ? ` · last call ${formatRelativeTime(lastEventAt)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-border/20">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={cn(
                  "px-2.5 py-1 text-xs transition-colors",
                  days === d ? "bg-brand/20 text-brand" : "text-muted-foreground hover:bg-muted/40",
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg",
              "bg-brand/10 text-brand hover:bg-brand/30",
              "border border-brand/20 transition-colors",
              loading && "opacity-50",
            )}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-xs text-danger flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {!summary && !loading && !error && gwStatus !== "connected" && (
        <p className="text-xs text-muted-foreground">Connect to the gateway to load usage.</p>
      )}

      {summary && !hasData && <EmptyState ledgerSupported={ledgerSupported} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as UsageTab)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} className="text-xs">
              {t.label}
              {t.id === "live" && liveEvents.length > 0 && (
                <span className="ml-1.5 rounded-full bg-brand/20 px-1.5 text-3xs text-brand">
                  {liveEvents.length}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          {summary && hasData && <UsageOverview summary={summary} />}
        </TabsContent>
        <TabsContent value="models">
          {summary && (
            <div className="space-y-4">
              <UsageModelsTable models={summary.byModel} />
              <UsageWhatIf />
            </div>
          )}
        </TabsContent>
        <TabsContent value="features">
          {summary && hasData && <UsageFeaturesPanel summary={summary} />}
        </TabsContent>
        <TabsContent value="sessions">
          <UsageSessionsList sessions={summary?.bySession ?? []} />
        </TabsContent>
        <TabsContent value="live">
          <UsageLiveFeed
            events={liveEvents}
            connected={gwStatus === "connected" && ledgerSupported !== false}
          />
        </TabsContent>
      </Tabs>

      {summary && (
        <p className="text-2xs text-muted-foreground/60">
          Ledger: {summary.ledger.events} rows
          {summary.ledger.dbBytes ? ` · ${(summary.ledger.dbBytes / 1_048_576).toFixed(1)} MB` : ""}
          {summary.ledger.lastReconcileAt
            ? ` · transcripts reconciled ${formatRelativeTime(summary.ledger.lastReconcileAt)}`
            : ""}
          {` · ${summary.ledger.retentionDays}d retention`}
          {summary.totals.unpricedCalls > 0
            ? ` · ${summary.totals.unpricedCalls} unpriced calls`
            : ""}
          {summary.totals.estimatedCalls > 0
            ? ` · ${summary.totals.estimatedCalls} estimated (≈)`
            : ""}
        </p>
      )}
    </div>
  );
}
