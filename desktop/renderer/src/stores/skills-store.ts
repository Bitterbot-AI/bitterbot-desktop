import { create } from "zustand";

export type SkillStatus = {
  key: string;
  name: string;
  description?: string;
  category?: string;
  enabled: boolean;
  installed: boolean;
  hasApiKey?: boolean;
  requires?: { bins?: string[] };
  metadata?: Record<string, unknown>;
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
      skills: s.skills.map((skill) =>
        skill.key === key ? { ...skill, ...patch } : skill,
      ),
    })),
}));
