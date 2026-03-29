import { create } from "zustand";

export type HealthSnapshot = {
  ts: number;
  uptime?: number;
  version?: string;
  platform?: string;
  nodeVersion?: string;
  configPath?: string;
  channels?: Record<string, unknown>;
  [key: string]: unknown;
};

export type StatusSummary = {
  version?: string;
  uptime?: number;
  pid?: number;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  configPath?: string;
  stateDir?: string;
  agents?: unknown[];
  channels?: Record<string, unknown>;
  sessions?: Record<string, unknown>;
  [key: string]: unknown;
};

type OverviewState = {
  health: HealthSnapshot | null;
  status: StatusSummary | null;
  loading: boolean;
  error: string | null;
  setHealth: (health: HealthSnapshot) => void;
  setStatus: (status: StatusSummary) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useOverviewStore = create<OverviewState>((set) => ({
  health: null,
  status: null,
  loading: false,
  error: null,
  setHealth: (health) => set({ health }),
  setStatus: (status) => set({ status }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
