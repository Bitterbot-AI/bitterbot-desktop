import { useCallback, useEffect, useState } from "react";
import { formatRelativeTime } from "../../lib/format";
import { cn } from "../../lib/utils";
import { useChannelsStore } from "../../stores/channels-store";
import { useGatewayStore } from "../../stores/gateway-store";
import { Switch } from "../ui/switch";

type ChannelAccount = {
  accountId: string;
  configured: boolean;
  enabled?: boolean;
  connected?: boolean;
  loggedIn?: boolean;
  status?: string;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  [key: string]: unknown;
};

type ChannelCapability = {
  supported: boolean;
  reason?: string;
  platforms?: string[];
};

type ChannelData = {
  channelId: string;
  label: string;
  accounts: ChannelAccount[];
  summary?: Record<string, unknown>;
  capability?: ChannelCapability;
};

function ChannelCard({
  channel,
  canToggle,
  togglingKey,
  onToggle,
  onLogout,
}: {
  channel: ChannelData;
  canToggle: boolean;
  togglingKey: string | null;
  onToggle: (channelId: string, accountId: string, enabled: boolean) => void;
  onLogout: (channelId: string, accountId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const primaryAccount = channel.accounts[0];
  const isConnected = primaryAccount?.connected || primaryAccount?.loggedIn;
  const unsupported = channel.capability?.supported === false;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm overflow-hidden",
        unsupported && "opacity-60",
      )}
    >
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div
          className={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            isConnected
              ? "bg-green-400"
              : primaryAccount?.configured
                ? "bg-yellow-400"
                : "bg-muted-foreground/30",
          )}
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-foreground">{channel.label}</span>
        </div>
        {unsupported ? (
          <span
            className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
            title={channel.capability?.reason}
          >
            unavailable on this host
          </span>
        ) : (
          <span
            className={cn(
              "text-xs px-2 py-0.5 rounded-full",
              isConnected
                ? "bg-green-500/10 text-green-400"
                : primaryAccount?.configured
                  ? "bg-yellow-500/10 text-yellow-400"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {isConnected
              ? "connected"
              : primaryAccount?.configured
                ? "configured"
                : "not configured"}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div className="px-4 pb-3 border-t border-border/10 pt-3 space-y-3">
          {unsupported && channel.capability?.reason && (
            <p className="text-xs text-muted-foreground">{channel.capability.reason}</p>
          )}
          {channel.accounts.map((account) => {
            const toggleKey = `${channel.channelId}:${account.accountId}`;
            return (
              <div key={account.accountId} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">
                    {account.accountId}
                  </span>
                  {account.enabled === false && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-400">
                      disabled
                    </span>
                  )}
                  {canToggle && !unsupported && (
                    <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={account.enabled !== false}
                        disabled={togglingKey === toggleKey}
                        onCheckedChange={(checked) =>
                          onToggle(channel.channelId, account.accountId, checked)
                        }
                        aria-label={`${account.enabled !== false ? "Disable" : "Enable"} ${channel.label} ${account.accountId}`}
                      />
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {account.lastInboundAt && (
                    <div>
                      <span className="text-muted-foreground">Last inbound: </span>
                      <span className="text-foreground">
                        {formatRelativeTime(account.lastInboundAt)}
                      </span>
                    </div>
                  )}
                  {account.lastOutboundAt && (
                    <div>
                      <span className="text-muted-foreground">Last outbound: </span>
                      <span className="text-foreground">
                        {formatRelativeTime(account.lastOutboundAt)}
                      </span>
                    </div>
                  )}
                </div>
                {(account.connected || account.loggedIn) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Logout ${channel.label} account "${account.accountId}"?`))
                        onLogout(channel.channelId, account.accountId);
                    }}
                    className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20"
                  >
                    Logout
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ChannelsView() {
  const gwStatus = useGatewayStore((s) => s.status);
  const request = useGatewayStore((s) => s.request);
  const hello = useGatewayStore((s) => s.hello);
  const loading = useChannelsStore((s) => s.loading);
  const setLoading = useChannelsStore((s) => s.setLoading);
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  // Version skew: older gateways don't implement channels.update; hide the
  // switches instead of rendering controls that error.
  const methods = hello?.features?.methods;
  const canToggle = methods ? methods.includes("channels.update") : true;

  const refresh = useCallback(
    async (probe = false) => {
      if (gwStatus !== "connected") return;
      setLoading(true);
      try {
        const res = (await request("channels.status", { probe })) as {
          channelOrder?: string[];
          channelLabels?: Record<string, string>;
          channelAccounts?: Record<string, ChannelAccount[]>;
          channelCapabilities?: Record<string, ChannelCapability>;
          channels?: Record<string, unknown>;
        };
        const order = res.channelOrder ?? Object.keys(res.channels ?? {});
        const labels = res.channelLabels ?? {};
        const accounts = res.channelAccounts ?? {};
        const capabilities = res.channelCapabilities ?? {};
        const channelSummaries = (res.channels ?? {}) as Record<string, Record<string, unknown>>;

        const parsed: ChannelData[] = order.map((id) => ({
          channelId: id,
          label: labels[id] ?? id,
          accounts: accounts[id] ?? [],
          summary: channelSummaries[id],
          capability: capabilities[id],
        }));
        setChannels(parsed);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load channels");
      } finally {
        setLoading(false);
      }
    },
    [gwStatus, request, setLoading],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleLogout = useCallback(
    async (channelId: string, accountId: string) => {
      try {
        await request("channels.logout", { channel: channelId, accountId });
        refresh();
      } catch (err) {
        alert(`Logout failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    },
    [request, refresh],
  );

  const handleToggle = useCallback(
    async (channelId: string, accountId: string, enabled: boolean) => {
      setTogglingKey(`${channelId}:${accountId}`);
      try {
        await request("channels.update", { channel: channelId, accountId, enabled });
        await refresh();
      } catch {
        // Central toast reports the failure; refresh so the switch snaps
        // back to the server's actual state instead of the failed intent.
        await refresh();
      } finally {
        setTogglingKey(null);
      }
    },
    [request, refresh],
  );

  return (
    <div className="h-full overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Channels</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {channels.length} channel{channels.length !== 1 ? "s" : ""} registered
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refresh(true)}
            disabled={loading}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg",
              "bg-purple-500/10 text-purple-300 hover:bg-purple-500/20",
              "border border-purple-500/20 transition-colors",
              loading && "opacity-50",
            )}
          >
            {loading ? "Probing…" : "Probe All"}
          </button>
          <button
            onClick={() => refresh(false)}
            disabled={loading}
            className={cn(
              "px-3 py-1.5 text-xs rounded-lg",
              "bg-muted/30 text-muted-foreground hover:bg-muted/50",
              "border border-border/20 transition-colors",
              loading && "opacity-50",
            )}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {channels.length === 0 && !loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm">
            No channels found
          </div>
        ) : (
          channels.map((channel) => (
            <ChannelCard
              key={channel.channelId}
              channel={channel}
              canToggle={canToggle}
              togglingKey={togglingKey}
              onToggle={handleToggle}
              onLogout={handleLogout}
            />
          ))
        )}
      </div>
    </div>
  );
}
