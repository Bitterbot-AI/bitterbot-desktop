import { create } from "zustand";
import { useGatewayStore } from "./gateway-store";

export interface ProjectFile {
  id: string;
  name: string;
  sizeBytes: number;
  addedAt: number;
}

export interface Project {
  id: string;
  name: string;
  systemPrompt: string;
  knowledgeBase: {
    files: ProjectFile[];
    autoRag: boolean;
    ragThresholdTokens: number;
  };
  createdAt: number;
  updatedAt: number;
}

interface ProjectsState {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;

  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Async actions (call gateway)
  fetchProjects: () => Promise<void>;
  createProject: (name: string, systemPrompt?: string) => Promise<Project | null>;
  updateProject: (id: string, updates: { name?: string; systemPrompt?: string }) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  uploadFile: (projectId: string, fileName: string, content: string) => Promise<void>;
  deleteFile: (projectId: string, fileId: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  loading: false,
  error: null,

  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (id) => set({ activeProjectId: id }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  fetchProjects: async () => {
    const request = useGatewayStore.getState().request;
    set({ loading: true, error: null });
    try {
      const res = await request<{ projects: Project[] }>("projects.list");
      set({ projects: res.projects ?? [], loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : "Failed to fetch projects",
        loading: false,
      });
    }
  },

  createProject: async (name, systemPrompt) => {
    const request = useGatewayStore.getState().request;
    try {
      const res = await request<{ project: Project }>("projects.create", { name, systemPrompt });
      if (res.project) {
        set((s) => ({ projects: [...s.projects, res.project] }));
        return res.project;
      }
      return null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to create project" });
      return null;
    }
  },

  updateProject: async (id, updates) => {
    const request = useGatewayStore.getState().request;
    try {
      const res = await request<{ project: Project }>("projects.update", { id, ...updates });
      if (res.project) {
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? res.project : p)),
        }));
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to update project" });
    }
  },

  deleteProject: async (id) => {
    const request = useGatewayStore.getState().request;
    try {
      await request("projects.delete", { id });
      set((s) => ({
        projects: s.projects.filter((p) => p.id !== id),
        activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to delete project" });
    }
  },

  uploadFile: async (projectId, fileName, content) => {
    const request = useGatewayStore.getState().request;
    try {
      await request("projects.files.upload", { projectId, fileName, content });
      // Re-fetch to get updated file list
      await get().fetchProjects();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to upload file" });
    }
  },

  deleteFile: async (projectId, fileId) => {
    const request = useGatewayStore.getState().request;
    try {
      await request("projects.files.delete", { projectId, fileId });
      await get().fetchProjects();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : "Failed to delete file" });
    }
  },
}));
