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
  /** Width of the right-hand "computer" pane in pixels; the person can drag it. */
  toolPanelWidth: number;
  theme: Theme;
  setActiveTab: (tab: TabId) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  toggleToolPanel: () => void;
  setToolPanelWidth: (width: number) => void;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const TOOL_PANEL_DEFAULT_WIDTH = 550;
export const TOOL_PANEL_MIN_WIDTH = 380;
/** Whatever the pane takes, the chat keeps at least this much. */
const TOOL_PANEL_CHAT_RESERVE = 420;
const TOOL_PANEL_WIDTH_KEY = "bitterbot-tool-panel-width";

/** Keep the pane usable and leave room for the chat beside it. */
export function clampToolPanelWidth(width: number, viewport = window.innerWidth): number {
  const max = Math.max(TOOL_PANEL_MIN_WIDTH, viewport - TOOL_PANEL_CHAT_RESERVE);
  return Math.round(Math.min(max, Math.max(TOOL_PANEL_MIN_WIDTH, width)));
}

function loadSavedToolPanelWidth(): number {
  try {
    const saved = Number(localStorage.getItem(TOOL_PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved > 0) return clampToolPanelWidth(saved);
  } catch {}
  return TOOL_PANEL_DEFAULT_WIDTH;
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
  toolPanelWidth: loadSavedToolPanelWidth(),
  theme: initialTheme,
  setActiveTab: (tab) => set({ activeTab: tab }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setToolPanelOpen: (open) => set({ toolPanelOpen: open }),
  toggleToolPanel: () => set((s) => ({ toolPanelOpen: !s.toolPanelOpen })),
  setToolPanelWidth: (width) => {
    const toolPanelWidth = clampToolPanelWidth(width);
    try {
      localStorage.setItem(TOOL_PANEL_WIDTH_KEY, String(toolPanelWidth));
    } catch {}
    set({ toolPanelWidth });
  },
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
