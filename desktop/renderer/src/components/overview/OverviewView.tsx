import { useCallback, useEffect } from "react";
import { useGatewayStore } from "../../stores/gateway-store";
import { useOverviewStore } from "../../stores/overview-store";
import { formatUptime, formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";

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
        accent
          ? "border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.1)]"
          : "border-border/20",
      )}
    >
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-xl font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

function ChannelCard({
  name,
  status,
}: {
  name: string;
  status: string;
}) {
  const isConnected = status === "connected" || status === "running";
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/30">
      <span className="text-sm text-foreground capitalize">{name}</span>
      <span
        className={cn(
          "text-xs px-2 py-0.5 rounded-full",
          isConnected
            ? "bg-green-500/10 text-green-400"
            : "bg-muted text-muted-foreground",
        )}
      >
        {status || "idle"}
      </span>
    </div>
  );
}

export function OverviewView() {
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
      const [h, s] = await Promise.all([
        request("health", {}),
        request("status", {}),
      ]);
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

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gateway dashboard
          </p>
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
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Version" value={String(version)} accent />
        <StatCard
          label="Uptime"
          value={typeof uptime === "number" ? formatUptime(uptime) : "—"}
        />
        <StatCard label="Platform" value={String(platform)} />
        <StatCard
          label="Channels"
          value={String(Object.keys(channels).length)}
          sub="registered"
        />
      </div>

      {/* Connection Info */}
      <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
        <h2 className="text-sm font-medium text-foreground mb-3">
          Gateway Connection
        </h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">Status: </span>
            <span
              className={cn(
                status === "connected" ? "text-green-400" : "text-yellow-400",
              )}
            >
              {status}
            </span>
          </div>
          {hello?.ts && (
            <div>
              <span className="text-muted-foreground">Connected: </span>
              <span className="text-foreground">
                {formatRelativeTime(hello.ts)}
              </span>
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
      </div>

      {/* Channel Summary */}
      {Object.keys(channels).length > 0 && (
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
          <h2 className="text-sm font-medium text-foreground mb-3">
            Channel Status
          </h2>
          <div className="space-y-1">
            {Object.entries(channels).map(([name, data]) => (
              <ChannelCard
                key={name}
                name={name}
                status={
                  typeof data === "object" && data
                    ? String((data as any).status ?? (data as any).configured ? "configured" : "idle")
                    : "idle"
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
