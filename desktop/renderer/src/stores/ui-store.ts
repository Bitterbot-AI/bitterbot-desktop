import { create } from "zustand";
// PLAN-41 p0-13: the nav manifest is the single source of truth for TabId.
// Re-exported here so the many existing `from "../stores/ui-store"` imports
// keep working.
import { DEFAULT_CONTROL_TAB, isControlTab, type TabId } from "../nav-manifest";

export type { TabId };

/** The theme actually painted. */
export type Theme = "dark" | "light";
/** What the person chose. "system" follows the OS and is the default. */
export type ThemePreference = Theme | "system";

interface UIState {
  activeTab: TabId;
  sidebarOpen: boolean;
  /** The Control Center view to return to. */
  controlTab: TabId;
  paletteOpen: boolean;
  toolPanelOpen: boolean;
  /** Width of the right-hand "computer" pane in pixels; the person can drag it. */
  toolPanelWidth: number;
  /** The effective theme. Components read this, never the preference. */
  theme: Theme;
  themePreference: ThemePreference;
  setActiveTab: (tab: TabId) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setToolPanelOpen: (open: boolean) => void;
  toggleToolPanel: () => void;
  setToolPanelWidth: (width: number) => void;
  /** Choose light, dark, or follow the system. */
  setTheme: (preference: ThemePreference) => void;
  /** Flip to the opposite of what is showing, as an explicit choice. */
  toggleTheme: () => void;
}

export const TOOL_PANEL_DEFAULT_WIDTH = 420;
export const TOOL_PANEL_MIN_WIDTH = 360;
/** Whatever the pane takes, the chat keeps at least this much. */
const TOOL_PANEL_CHAT_RESERVE = 560;
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

const SIDEBAR_OPEN_KEY = "bitterbot-sidebar-open";
const CONTROL_TAB_KEY = "bitterbot-control-tab";

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

function saveSidebarOpen(open: boolean) {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {}
}

function loadControlTab(): TabId {
  try {
    const saved = localStorage.getItem(CONTROL_TAB_KEY) as TabId | null;
    if (saved && isControlTab(saved)) return saved;
  } catch {}
  return DEFAULT_CONTROL_TAB;
}

const THEME_KEY = "bitterbot-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Keep in step with the pre-paint script in index.html. */
export function resolveTheme(preference: ThemePreference): Theme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

/**
 * A stored "light" or "dark" is an explicit choice and is kept. Anything else,
 * including nothing at all on a new profile, means follow the system.
 */
export function loadThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return "system";
}

function paintTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function persistThemePreference(preference: ThemePreference) {
  try {
    // "system" is stored as absence, so a profile that never chose keeps
    // following the OS and the pre-paint script needs no third case.
    if (preference === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {}
}

const initialPreference = loadThemePreference();
const initialTheme = resolveTheme(initialPreference);

export const useUIStore = create<UIState>((set) => ({
  activeTab: "chat",
  sidebarOpen: loadSidebarOpen(),
  controlTab: loadControlTab(),
  paletteOpen: false,
  toolPanelOpen: false,
  toolPanelWidth: loadSavedToolPanelWidth(),
  theme: initialTheme,
  themePreference: initialPreference,
  setActiveTab: (tab) => {
    if (!isControlTab(tab)) {
      set({ activeTab: tab });
      return;
    }
    // Remember the last Control Center view so re-entry returns to it.
    try {
      localStorage.setItem(CONTROL_TAB_KEY, tab);
    } catch {}
    set({ activeTab: tab, controlTab: tab });
  },
  toggleSidebar: () =>
    set((s) => {
      saveSidebarOpen(!s.sidebarOpen);
      return { sidebarOpen: !s.sidebarOpen };
    }),
  setSidebarOpen: (open) => {
    saveSidebarOpen(open);
    set({ sidebarOpen: open });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setToolPanelOpen: (open) => set({ toolPanelOpen: open }),
  toggleToolPanel: () => set((s) => ({ toolPanelOpen: !s.toolPanelOpen })),
  setToolPanelWidth: (width) => {
    const toolPanelWidth = clampToolPanelWidth(width);
    try {
      localStorage.setItem(TOOL_PANEL_WIDTH_KEY, String(toolPanelWidth));
    } catch {}
    set({ toolPanelWidth });
  },
  setTheme: (preference) => {
    const theme = resolveTheme(preference);
    persistThemePreference(preference);
    paintTheme(theme);
    set({ theme, themePreference: preference });
  },
  toggleTheme: () =>
    set((s) => {
      const next: Theme = s.theme === "dark" ? "light" : "dark";
      persistThemePreference(next);
      paintTheme(next);
      return { theme: next, themePreference: next };
    }),
}));

// Paint on load. index.html already did this before first paint; repeating it
// covers hosts that serve the bundle without that script.
paintTheme(initialTheme);

// While following the system, track OS changes live.
try {
  window.matchMedia?.(DARK_QUERY).addEventListener("change", () => {
    const state = useUIStore.getState();
    if (state.themePreference !== "system") return;
    const theme = resolveTheme("system");
    paintTheme(theme);
    useUIStore.setState({ theme });
  });
} catch {}
