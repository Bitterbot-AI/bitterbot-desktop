import { create } from "zustand";

export type ArtifactType = "react" | "html" | "svg" | "mermaid" | "javascript";

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type RightPanelMode = "tools" | "artifact" | "tasks" | "files";

interface ArtifactState {
  /** All known artifacts keyed by id */
  artifacts: Map<string, Artifact>;
  /** Currently displayed artifact id */
  activeArtifactId: string | null;
  /** Which tab is active in the right panel */
  panelMode: RightPanelMode;

  /** Add or update an artifact */
  upsertArtifact: (artifact: Artifact) => void;
  /** Set the active artifact and switch to artifact panel mode */
  openArtifact: (id: string) => void;
  /** Switch panel mode */
  setPanelMode: (mode: RightPanelMode) => void;
  /** Clear all artifacts (e.g., on session change) */
  clearArtifacts: () => void;
}

export const useArtifactStore = create<ArtifactState>((set) => ({
  artifacts: new Map(),
  activeArtifactId: null,
  panelMode: "tools",

  upsertArtifact: (artifact) =>
    set((s) => {
      const next = new Map(s.artifacts);
      const existing = next.get(artifact.id);
      if (existing) {
        next.set(artifact.id, {
          ...existing,
          ...artifact,
          version: Math.max(existing.version, artifact.version),
          updatedAt: Date.now(),
        });
      } else {
        next.set(artifact.id, { ...artifact, createdAt: Date.now(), updatedAt: Date.now() });
      }
      return { artifacts: next };
    }),

  openArtifact: (id) =>
    set({ activeArtifactId: id, panelMode: "artifact" }),

  setPanelMode: (mode) => set({ panelMode: mode }),

  clearArtifacts: () =>
    set({ artifacts: new Map(), activeArtifactId: null, panelMode: "tools" }),
}));
