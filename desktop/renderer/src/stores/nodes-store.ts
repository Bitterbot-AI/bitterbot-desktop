import { create } from "zustand";

export type NodeEntry = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  remoteIp?: string;
  caps: string[];
  commands: string[];
  connectedAtMs?: number;
  paired: boolean;
  connected: boolean;
};

export type PairRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  ts: number;
  [key: string]: unknown;
};

type NodesState = {
  nodes: NodeEntry[];
  pairRequests: PairRequest[];
  loading: boolean;
  error: string | null;
  setNodes: (nodes: NodeEntry[]) => void;
  setPairRequests: (requests: PairRequest[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useNodesStore = create<NodesState>((set) => ({
  nodes: [],
  pairRequests: [],
  loading: false,
  error: null,
  setNodes: (nodes) => set({ nodes }),
  setPairRequests: (requests) => set({ pairRequests: requests }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
