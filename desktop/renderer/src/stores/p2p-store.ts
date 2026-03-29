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
  error: string | null;
  loading: boolean;

  fetchStats: (httpAddr?: string) => Promise<void>;
  fetchContributions: (httpAddr?: string) => Promise<void>;
  fetchIncomingSkills: () => Promise<void>;
  setConnected: (connected: boolean) => void;
}

const DEFAULT_HTTP_ADDR = "http://127.0.0.1:9847";

export const useP2pStore = create<P2pState>((set) => ({
  connected: false,
  stats: null,
  contributions: null,
  incomingSkills: [],
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
}));
