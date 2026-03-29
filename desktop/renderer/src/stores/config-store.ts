import { create } from "zustand";

export type ConfigSnapshot = {
  exists: boolean;
  valid: boolean;
  raw?: string;
  config?: Record<string, unknown>;
  baseHash?: string;
  path?: string;
  [key: string]: unknown;
};

export type ConfigSchema = {
  schema?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  [key: string]: unknown;
};

type ConfigState = {
  snapshot: ConfigSnapshot | null;
  schema: ConfigSchema | null;
  rawMode: boolean;
  rawDraft: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setSnapshot: (snapshot: ConfigSnapshot) => void;
  setSchema: (schema: ConfigSchema) => void;
  setRawMode: (rawMode: boolean) => void;
  setRawDraft: (rawDraft: string) => void;
  setLoading: (loading: boolean) => void;
  setSaving: (saving: boolean) => void;
  setError: (error: string | null) => void;
};

export const useConfigStore = create<ConfigState>((set) => ({
  snapshot: null,
  schema: null,
  rawMode: false,
  rawDraft: "",
  loading: false,
  saving: false,
  error: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setSchema: (schema) => set({ schema }),
  setRawMode: (rawMode) => set({ rawMode }),
  setRawDraft: (rawDraft) => set({ rawDraft }),
  setLoading: (loading) => set({ loading }),
  setSaving: (saving) => set({ saving }),
  setError: (error) => set({ error }),
}));
