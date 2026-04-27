import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export type P2pPeer = {
  peer_id: string;
  addrs?: string[];
  connected_at?: number;
};

export type P2pStats = {
  peer_id: string;
  connected_peers: number;
  skills_published: number;
  skills_received: number;
  uptime_secs: number;
  // Tier 1 + Tier 3 metrics surfaced from the orchestrator's /api/stats.
  peak_concurrent_peers?: number;
  lifetime_unique_peer_ids?: number;
  peers_joined_total?: number;
  peers_left_total?: number;
  joins_per_minute?: Array<[number, number]>;
  leaves_per_minute?: Array<[number, number]>;
  mesh_peers_per_topic?: Record<string, number>;
  routing_table_size?: number;
  time_to_first_peer_ms?: number | null;
  address_types?: Record<string, number>;
  relay_reservations_accepted?: number;
  relay_circuits_established?: number;
  hole_punches_succeeded?: number;
  hole_punches_failed?: number;
  nat_status?: string;
  bytes_received_per_topic?: Record<string, number>;
  bytes_published_per_topic?: Record<string, number>;
  skill_latency_p50_ms?: number | null;
  skill_latency_p95_ms?: number | null;
  skill_latency_samples?: number;
};

export type P2pBootstrapCensus = {
  enabled: boolean;
  lifetime_unique_peers: number;
  active_last_24h: number;
  active_last_7d: number;
  by_tier: Record<string, number>;
  by_address_type: Record<string, number>;
  generated_at: number;
};

/** Live gossipsub-pushed network census from skills.network RPC. */
export type P2pNetworkCensus = {
  source_peer_id: string;
  snapshot: {
    enabled: boolean;
    lifetime_unique_peers: number;
    active_last_24h: number;
    active_last_7d: number;
    by_tier: Record<string, number>;
    by_address_type: Record<string, number>;
    generated_at: number;
    received_at?: number;
  };
};

/** Persisted census history row from skills.networkHistory RPC. */
export type P2pCensusHistoryRow = {
  sourcePeerId: string;
  generatedAt: number;
  snapshotAt: number;
  lifetimeUniquePeers: number;
  activeLast24h: number;
  activeLast7d: number;
  byTier: Record<string, number>;
  byAddressType: Record<string, number>;
};

export type P2pContributions = {
  skills_published: number;
  skills_verified: number;
  uptime_hours: number;
  score: number;
};

export type P2pIncomingSkill = {
  name: string;
  author_peer_id?: string;
  timestamp?: number;
};

interface P2pState {
  connected: boolean;
  stats: P2pStats | null;
  contributions: P2pContributions | null;
  incomingSkills: P2pIncomingSkill[];
  bootstrapCensus: P2pBootstrapCensus | null;
  networkCensus: P2pNetworkCensus | null;
  censusHistory: P2pCensusHistoryRow[];
  error: string | null;
  loading: boolean;

  fetchStats: (httpAddr?: string) => Promise<void>;
  fetchContributions: (httpAddr?: string) => Promise<void>;
  fetchIncomingSkills: () => Promise<void>;
  fetchBootstrapCensus: (httpAddr?: string) => Promise<void>;
  fetchNetworkCensus: () => Promise<void>;
  fetchCensusHistory: (opts?: {
    sourcePeerId?: string;
    sinceMs?: number;
    limit?: number;
  }) => Promise<void>;
  setConnected: (connected: boolean) => void;
}

const DEFAULT_HTTP_ADDR = "http://127.0.0.1:9847";

export const useP2pStore = create<P2pState>((set) => ({
  connected: false,
  stats: null,
  contributions: null,
  incomingSkills: [],
  bootstrapCensus: null,
  networkCensus: null,
  censusHistory: [],
  error: null,
  loading: false,

  setConnected: (connected) => set({ connected }),

  fetchStats: async (httpAddr) => {
    set({ loading: true, error: null });
    try {
      const base = httpAddr ?? DEFAULT_HTTP_ADDR;
      const res = await fetch(`${base}/api/stats`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stats = (await res.json()) as P2pStats;
      set({ stats, connected: true, loading: false });
    } catch (err) {
      set({ error: String(err), connected: false, loading: false });
    }
  },

  fetchContributions: async (httpAddr) => {
    try {
      const base = httpAddr ?? DEFAULT_HTTP_ADDR;
      const res = await fetch(`${base}/api/contributions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contributions = (await res.json()) as P2pContributions;
      set({ contributions });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  fetchIncomingSkills: async () => {
    // This uses the gateway RPC, not the orchestrator HTTP API
    // In a real implementation, this would call the gateway client
    set({ incomingSkills: [] });
  },

  fetchBootstrapCensus: async (httpAddr) => {
    try {
      const base = httpAddr ?? DEFAULT_HTTP_ADDR;
      const res = await fetch(`${base}/api/bootstrap/census`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bootstrapCensus = (await res.json()) as P2pBootstrapCensus;
      set({ bootstrapCensus });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  fetchNetworkCensus: async () => {
    // Goes through the gateway WS instead of the local orchestrator HTTP
    // because the data is gossipsub-pushed and lives in the TS bridge cache.
    try {
      const request = useGatewayStore.getState().request;
      const res = await request<{ networkCensus: P2pNetworkCensus | null }>("skills.network");
      set({ networkCensus: res?.networkCensus ?? null });
    } catch (err) {
      // Silent — first-load races and disconnect noise shouldn't toast.
      set({ error: String(err) });
    }
  },

  fetchCensusHistory: async (opts) => {
    try {
      const request = useGatewayStore.getState().request;
      const params: Record<string, unknown> = {};
      if (opts?.sourcePeerId) {
        params.sourcePeerId = opts.sourcePeerId;
      }
      if (typeof opts?.sinceMs === "number") {
        params.sinceMs = opts.sinceMs;
      }
      if (typeof opts?.limit === "number") {
        params.limit = opts.limit;
      }
      const res = await request<{ rows: P2pCensusHistoryRow[]; count: number }>(
        "skills.networkHistory",
        params,
      );
      set({ censusHistory: res?.rows ?? [] });
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
