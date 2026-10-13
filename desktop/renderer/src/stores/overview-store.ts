import { create } from "zustand";

/** The `health` RPC result (HealthSummary in src/commands/health.ts). */
export type HealthSnapshot = {
  ts: number;
  channels?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The gateway process's facts (GatewayRuntimeSchema in src/gateway/protocol/schema/snapshot.ts). */
export type GatewayRuntimeInfo = {
  version?: string;
  uptimeMs?: number;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  installKind?: "git" | "package" | "container" | "tarball" | "unknown";
};

/** The `status` RPC result: the CLI status summary plus `runtime`. */
export type StatusSummary = {
  runtime?: GatewayRuntimeInfo;
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
