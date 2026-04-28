import { create } from "zustand";

export type SkillState =
  | "ready"
  | "disabled-by-user"
  | "missing-os"
  | "missing-bin"
  | "missing-env"
  | "missing-config"
  | "blocked-by-allowlist";

export type SkillInstallOption = {
  id: string;
  kind: string;
  label: string;
  bins: string[];
};

export type SkillOrigin = {
  registry?: string;
  slug?: string;
  version?: string;
  license?: string;
  upstreamUrl?: string;
};

export type SkillStatus = {
  key: string;
  name: string;
  description?: string;
  category?: string;
  enabled: boolean;
  installed: boolean;
  hasApiKey: boolean;
  state: SkillState;
  reasons: string[];
  platformLabel?: string;
  primaryEnv?: string;
  requires?: { bins?: string[] };
  install?: SkillInstallOption[];
  origin?: SkillOrigin;
};

type SkillsState = {
  skills: SkillStatus[];
  loading: boolean;
  error: string | null;
  filter: string;
  setSkills: (skills: SkillStatus[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setFilter: (filter: string) => void;
  updateSkill: (key: string, patch: Partial<SkillStatus>) => void;
};

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: [],
  loading: false,
  error: null,
  filter: "",
  setSkills: (skills) => set({ skills }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setFilter: (filter) => set({ filter }),
  updateSkill: (key, patch) =>
    set((s) => ({
      skills: s.skills.map((skill) => (skill.key === key ? { ...skill, ...patch } : skill)),
    })),
}));
