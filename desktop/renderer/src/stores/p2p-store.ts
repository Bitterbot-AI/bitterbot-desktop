import { create } from "zustand";

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
  error: string | null;
  loading: boolean;

  fetchStats: (httpAddr?: string) => Promise<void>;
  fetchContributions: (httpAddr?: string) => Promise<void>;
  fetchIncomingSkills: () => Promise<void>;
  fetchBootstrapCensus: (httpAddr?: string) => Promise<void>;
  setConnected: (connected: boolean) => void;
}

const DEFAULT_HTTP_ADDR = "http://127.0.0.1:9847";

export const useP2pStore = create<P2pState>((set) => ({
  connected: false,
  stats: null,
  contributions: null,
  incomingSkills: [],
  bootstrapCensus: null,
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
}));
