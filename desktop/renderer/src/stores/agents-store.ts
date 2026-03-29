import { create } from "zustand";

export type AgentEntry = {
  id: string;
  name?: string;
  workspace?: string;
  model?: string;
  avatar?: string;
  isDefault?: boolean;
};

export type AgentFile = {
  name: string;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
};

type AgentsState = {
  agents: AgentEntry[];
  selectedAgentId: string | null;
  files: AgentFile[];
  filesLoading: boolean;
  loading: boolean;
  error: string | null;
  setAgents: (agents: AgentEntry[]) => void;
  setSelectedAgentId: (id: string | null) => void;
  setFiles: (files: AgentFile[]) => void;
  setFilesLoading: (loading: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const useAgentsStore = create<AgentsState>((set) => ({
  agents: [],
  selectedAgentId: null,
  files: [],
  filesLoading: false,
  loading: false,
  error: null,
  setAgents: (agents) => set({ agents }),
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setFiles: (files) => set({ files }),
  setFilesLoading: (loading) => set({ filesLoading: loading }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
