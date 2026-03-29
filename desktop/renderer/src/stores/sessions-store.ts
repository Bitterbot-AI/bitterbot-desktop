import { create } from "zustand";

export type SessionEntry = {
  key: string;
  sessionId?: string;
  label?: string;
  updatedAt?: number;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  model?: string;
  modelProvider?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  channel?: string;
  origin?: Record<string, unknown>;
  [key: string]: unknown;
};

type SessionsState = {
  sessions: SessionEntry[];
  loading: boolean;
  error: string | null;
  filter: string;
  setSessions: (sessions: SessionEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setFilter: (filter: string) => void;
  removeSession: (key: string) => void;
  updateSession: (key: string, patch: Partial<SessionEntry>) => void;
};

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: [],
  loading: false,
  error: null,
  filter: "",
  setSessions: (sessions) => set({ sessions }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFilter: (filter) => set({ filter }),
  removeSession: (key) =>
    set((s) => ({ sessions: s.sessions.filter((session) => session.key !== key) })),
  updateSession: (key, patch) =>
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.key === key ? { ...session, ...patch } : session,
      ),
    })),
}));
