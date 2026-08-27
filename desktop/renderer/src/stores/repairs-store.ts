/**
 * PLAN-41 Phase 2: doctor findings for the Repairs card + the sidebar
 * attention count. Fetched by RepairsCard; read by Sidebar for the badge.
 */
import { create } from "zustand";

export type RepairFinding = {
  section: string;
  level: "ok" | "info" | "warn" | "error";
  message: string;
};

type RepairsState = {
  findings: RepairFinding[];
  checkedAt: number | null;
  loading: boolean;
  setFindings: (findings: RepairFinding[], checkedAt: number) => void;
  setLoading: (loading: boolean) => void;
};

export const useRepairsStore = create<RepairsState>((set) => ({
  findings: [],
  checkedAt: null,
  loading: false,
  setFindings: (findings, checkedAt) => set({ findings, checkedAt }),
  setLoading: (loading) => set({ loading }),
}));

/** warn+error count — what the sidebar badge shows. */
export function repairsAttention(findings: RepairFinding[]): number {
  return findings.filter((f) => f.level === "warn" || f.level === "error").length;
}
