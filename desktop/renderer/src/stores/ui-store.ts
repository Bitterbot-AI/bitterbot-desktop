import { create } from "zustand";

export type TabId =
  | "chat"
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "usage"
  | "cron"
  | "agents"
  | "skills"
  | "nodes"
  | "projects"
  | "workspace"
  | "wallet"
  | "p2p"
  | "dreams"
  | "management"
  | "config"
  | "debug"
  | "logs";

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
  setTheme: (theme) => { applyTheme(theme); set({ theme }); },
  toggleTheme: () => set((s) => {
    const next = s.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    return { theme: next };
  }),
}));

// Apply saved theme on load (in case index.html has class="dark" hardcoded)
applyTheme(initialTheme);
