import { useCallback, useEffect } from "react";
import { formatUptime, formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useGatewayStore } from "../../stores/gateway-store";
import { useOverviewStore } from "../../stores/overview-store";
import { useUIStore } from "../../stores/ui-store";
import { GatewayControls } from "./GatewayControls";
import { GetStartedCard } from "./GetStartedCard";
import { RepairsCard } from "./RepairsCard";
import { UpdateCard } from "./UpdateCard";

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        "bg-card/60 backdrop-blur-sm",
        accent ? "border-brand/30 shadow-[0_0_15px_rgba(168,85,247,0.1)]" : "border-border/20",
      )}
    >
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

function ChannelCard({ name, linked }: { name: string; linked: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/30">
      <span className="text-sm text-foreground capitalize">{name}</span>
      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-full",
          linked ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {linked ? "linked" : "configured"}
      </span>
    </div>
  );
}

/**
 * PLAN-41 p0-17 (overview-channels): status derives from the keys the health
 * snapshot actually has (configured/linked, per channel or per account) —
 * the old code read a `status` key that never existed.
 */
function summarizeChannels(
  channels: Record<string, unknown>,
): Array<{ name: string; configured: boolean; linked: boolean }> {
  return Object.entries(channels).map(([name, data]) => {
    const d = (data ?? {}) as {
      configured?: boolean;
      linked?: boolean;
      accounts?: Record<string, { configured?: boolean; linked?: boolean } | undefined>;
    };
    const accounts = d.accounts ? Object.values(d.accounts) : [];
    return {
      name,
      configured: d.configured === true || accounts.some((a) => a?.configured === true),
      linked: d.linked === true || accounts.some((a) => a?.linked === true),
    };
  });
}

export function OverviewView() {
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const status = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const hello = useGatewayStore((s) => s.hello);
  const health = useOverviewStore((s) => s.health);
  const statusData = useOverviewStore((s) => s.status);
  const loading = useOverviewStore((s) => s.loading);
  const setHealth = useOverviewStore((s) => s.setHealth);
  const setStatus = useOverviewStore((s) => s.setStatus);
  const setLoading = useOverviewStore((s) => s.setLoading);
  const setError = useOverviewStore((s) => s.setError);

  const refresh = useCallback(async () => {
    if (status !== "connected") return;
    setLoading(true);
    try {
      const [h, s] = await Promise.all([request("health", {}), request("status", {})]);
      setHealth(h as any);
      setStatus(s as any);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [status, request, setHealth, setStatus, setLoading, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const version = statusData?.version ?? hello?.version ?? "—";
  const uptime = statusData?.uptime ?? health?.uptime;
  const platform = statusData?.platform ?? "—";
  const channels = health?.channels ?? {};
  const configuredChannels = summarizeChannels(channels).filter((c) => c.configured);

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">Gateway dashboard</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className={cn(
            "px-3 py-1.5 text-xs rounded-lg",
            "bg-brand/10 text-brand hover:bg-brand/30",
            "border border-brand/20 transition-colors",
            loading && "opacity-50",
          )}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Version" value={String(version)} accent />
        <StatCard label="Uptime" value={typeof uptime === "number" ? formatUptime(uptime) : "—"} />
        <StatCard label="Platform" value={String(platform)} />
        <StatCard label="Channels" value={String(configuredChannels.length)} sub="configured" />
      </div>

      {/* Doctor-fed repairs (renders only when something needs attention) */}
      <RepairsCard />

      {/* First-run checklist (self-dismisses when complete) */}
      <GetStartedCard channelsConfigured={configuredChannels.length > 0} />

      {/* Version & updates */}
      <UpdateCard />

      {/* Connection Info */}
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h2 className="text-sm font-medium text-foreground mb-3">Gateway Connection</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">Status: </span>
            <span className={cn(status === "connected" ? "text-success" : "text-warning")}>
              {status}
            </span>
          </div>
          {hello?.ts && (
            <div>
              <span className="text-muted-foreground">Connected: </span>
              <span className="text-foreground">{formatRelativeTime(hello.ts)}</span>
            </div>
          )}
          {statusData?.configPath && (
            <div className="col-span-2">
              <span className="text-muted-foreground">Config: </span>
              <span className="text-foreground font-mono text-xs">
                {String(statusData.configPath)}
              </span>
            </div>
          )}
          {statusData?.stateDir && (
            <div className="col-span-2">
              <span className="text-muted-foreground">State Dir: </span>
              <span className="text-foreground font-mono text-xs">
                {String(statusData.stateDir)}
              </span>
            </div>
          )}
        </div>
        <GatewayControls />
      </div>

      {/* Channel Summary — configured channels only; fresh installs get a CTA */}
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h2 className="text-sm font-medium text-foreground mb-3">Channel Status</h2>
        {configuredChannels.length > 0 ? (
          <div className="space-y-1">
            {configuredChannels.map((c) => (
              <ChannelCard key={c.name} name={c.name} linked={c.linked} />
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 py-2">
            <p className="text-sm text-muted-foreground">
              No channels configured yet. Connect Telegram, WhatsApp, Discord, Slack or Signal so
              people can talk to your agent.
            </p>
            <button
              onClick={() => setActiveTab("channels")}
              className="flex-shrink-0 px-3 py-1.5 text-xs rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
            >
              Set up channels
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
