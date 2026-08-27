import { create } from "zustand";
// PLAN-41 p0-13: the nav manifest is the single source of truth for TabId.
// Re-exported here so the many existing `from "../stores/ui-store"` imports
// keep working.
import type { TabId } from "../nav-manifest";

export type { TabId };

export type Theme = "dark" | "light";

interface UIState {
  activeTab: TabId;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  toolPanelOpen: boolean;
  theme: Theme;
  setActiveTab: (tab: TabId) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  toggleToolPanel: () => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("bitterbot-theme", theme);
}

function loadSavedTheme(): Theme {
  try {
    const saved = localStorage.getItem("bitterbot-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "dark";
}

const initialTheme = loadSavedTheme();

export const useUIStore = create<UIState>((set) => ({
  activeTab: "chat",
  sidebarOpen: true,
  sidebarCollapsed: false,
  toolPanelOpen: false,
  theme: initialTheme,
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setToolPanelOpen: (open) => set({ toolPanelOpen: open }),
  toggleToolPanel: () => set((s) => ({ toolPanelOpen: !s.toolPanelOpen })),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((s) => {
      const next = s.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      return { theme: next };
    }),
}));

// Apply saved theme on load (in case index.html has class="dark" hardcoded)
applyTheme(initialTheme);
