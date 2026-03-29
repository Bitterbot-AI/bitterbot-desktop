import { create } from "zustand";

export type LogLine = {
  text: string;
  level?: "info" | "warn" | "error" | "debug";
};

type LogsState = {
  lines: string[];
  cursor: number | null;
  file: string | null;
  autoScroll: boolean;
  filter: string;
  levelFilter: Set<string>;
  loading: boolean;
  error: string | null;
  setLines: (lines: string[]) => void;
  appendLines: (lines: string[]) => void;
  setCursor: (cursor: number) => void;
  setFile: (file: string) => void;
  setAutoScroll: (autoScroll: boolean) => void;
  setFilter: (filter: string) => void;
  toggleLevel: (level: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clear: () => void;
};

export const useLogsStore = create<LogsState>((set) => ({
  lines: [],
  cursor: null,
  file: null,
  autoScroll: true,
  filter: "",
  levelFilter: new Set(["info", "warn", "error", "debug"]),
  loading: false,
  error: null,
  setLines: (lines) => set({ lines }),
  appendLines: (newLines) =>
    set((s) => {
      const combined = [...s.lines, ...newLines];
      // Keep last 5000 lines
      return { lines: combined.length > 5000 ? combined.slice(-5000) : combined };
    }),
  setCursor: (cursor) => set({ cursor }),
  setFile: (file) => set({ file }),
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  setFilter: (filter) => set({ filter }),
  toggleLevel: (level) =>
    set((s) => {
      const next = new Set(s.levelFilter);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return { levelFilter: next };
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  clear: () => set({ lines: [], cursor: null }),
}));
