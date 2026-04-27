import { useEffect } from "react";
import { useP2pStore } from "../../stores/p2p-store";
import { CensusBreakdown } from "./CensusBreakdown";
import { ContributionCard } from "./ContributionCard";
import { NetworkGrowthSparkline } from "./NetworkGrowthSparkline";
import { PeerMap } from "./PeerMap";

export function P2pDashboard() {
  const {
    stats,
    contributions,
    connected,
    loading,
    error,
    bootstrapCensus,
    networkCensus,
    censusHistory,
    fetchStats,
    fetchContributions,
    fetchBootstrapCensus,
    fetchNetworkCensus,
    fetchCensusHistory,
  } = useP2pStore();

  useEffect(() => {
    fetchStats();
    fetchContributions();
    fetchBootstrapCensus();
    fetchNetworkCensus();
    fetchCensusHistory({ limit: 500 });
    const interval = setInterval(() => {
      fetchStats();
      fetchContributions();
      fetchBootstrapCensus();
      fetchNetworkCensus();
      fetchCensusHistory({ limit: 500 });
    }, 30_000);
    return () => clearInterval(interval);
  }, [
    fetchStats,
    fetchContributions,
    fetchBootstrapCensus,
    fetchNetworkCensus,
    fetchCensusHistory,
  ]);

  // Pick the freshest census source for the breakdown panel: live
  // gossipsub-pushed snapshot wins, fall back to the local HTTP polled
  // bootstrapCensus when this node is itself a bootnode.
  const breakdownSource = networkCensus?.snapshot ?? bootstrapCensus ?? null;

  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-y-auto">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">P2P Network</h1>
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            connected
              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
              : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
          }`}
        >
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 backdrop-blur-sm p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Disconnected empty state */}
      {!connected && !loading && !error && (
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-6 text-center space-y-2">
          <p className="text-sm text-muted-foreground">The P2P orchestrator is not running.</p>
          <p className="text-xs text-muted-foreground/60">
            Enable P2P in your config and restart the gateway to connect to the network.
          </p>
        </div>
      )}

      {loading && !stats && (
        <div className="text-sm text-muted-foreground">Loading network stats...</div>
      )}

      {/* Contribution Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <ContributionCard
          title="Connected Peers"
          value={stats?.connected_peers ?? 0}
          icon="users"
        />
        <ContributionCard
          title="Skills Published"
          value={stats?.skills_published ?? 0}
          icon="upload"
        />
        <ContributionCard
          title="Skills Received"
          value={stats?.skills_received ?? 0}
          icon="download"
        />
        <ContributionCard
          title="Contribution Score"
          value={contributions?.score?.toFixed(1) ?? "0.0"}
          icon="trophy"
        />
      </div>

      {/* Network-wide and lifetime metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <ContributionCard
          title={bootstrapCensus?.enabled ? "Network Peers (lifetime)" : "Peer IDs (this session)"}
          value={
            bootstrapCensus?.enabled
              ? bootstrapCensus.lifetime_unique_peers
              : (stats?.lifetime_unique_peer_ids ?? 0)
          }
          icon="users"
        />
        <ContributionCard
          title="Peak Concurrent Peers"
          value={stats?.peak_concurrent_peers ?? 0}
          icon="users"
        />
        <ContributionCard
          title="Routing Table Size"
          value={stats?.routing_table_size ?? 0}
          icon="users"
        />
        <ContributionCard title="NAT Status" value={stats?.nat_status ?? "unknown"} icon="users" />
      </div>

      {/* Network-wide breakdown (gossipsub-pushed when available, falls back
          to local bootstrap census when this node is the bootnode). */}
      <CensusBreakdown
        byTier={breakdownSource?.by_tier ?? null}
        byAddressType={breakdownSource?.by_address_type ?? null}
        source={networkCensus?.source_peer_id ?? null}
        generatedAt={breakdownSource?.generated_at ?? null}
      />

      {/* Network growth over time, persisted across restarts in
          network_census_history. */}
      <NetworkGrowthSparkline rows={censusHistory} />

      {/* Uptime & Peer Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border/20 bg-card/60 backdrop-blur-sm p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">Node Info</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Peer ID</span>
              <span className="font-mono text-xs truncate max-w-[300px]">
                {stats?.peer_id ?? "\u2014"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Uptime</span>
              <span>{formatUptime(stats?.uptime_secs ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Skills Published</span>
              <span>{contributions?.skills_published ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Skills Verified</span>
              <span>{contributions?.skills_verified ?? 0}</span>
            </div>
          </div>
        </div>

        {/* Peer Map */}
        <PeerMap connectedPeers={stats?.connected_peers ?? 0} />
      </div>
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return `${hours}h ${mins}m`;
}
