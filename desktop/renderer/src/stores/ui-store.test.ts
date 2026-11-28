import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampToolPanelWidth,
  loadThemePreference,
  resolveTheme,
  TOOL_PANEL_DEFAULT_WIDTH,
  TOOL_PANEL_MIN_WIDTH,
  useUIStore,
} from "./ui-store";

describe("the computer pane's width", () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ toolPanelWidth: TOOL_PANEL_DEFAULT_WIDTH });
  });

  it("stays usable and leaves room for the chat", () => {
    expect(clampToolPanelWidth(100, 1600)).toBe(TOOL_PANEL_MIN_WIDTH);
    expect(clampToolPanelWidth(5000, 1600)).toBe(1180);
    expect(clampToolPanelWidth(700.4, 1600)).toBe(700);
    // On a narrow window the pane keeps its minimum rather than going negative.
    expect(clampToolPanelWidth(900, 600)).toBe(TOOL_PANEL_MIN_WIDTH);
  });

  it("remembers what the person dragged it to", () => {
    useUIStore.getState().setToolPanelWidth(50);

    expect(useUIStore.getState().toolPanelWidth).toBe(TOOL_PANEL_MIN_WIDTH);
    expect(localStorage.getItem("bitterbot-tool-panel-width")).toBe(String(TOOL_PANEL_MIN_WIDTH));
  });
});

describe("the theme", () => {
  const stubSystem = (dark: boolean) =>
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: dark, addEventListener: () => {}, removeEventListener: () => {} })),
    );

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the system on a profile that never chose", () => {
    expect(loadThemePreference()).toBe("system");
    stubSystem(true);
    expect(resolveTheme("system")).toBe("dark");
    stubSystem(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("keeps a choice an existing profile already stored", () => {
    localStorage.setItem("bitterbot-theme", "dark");
    expect(loadThemePreference()).toBe("dark");
    stubSystem(false);
    expect(resolveTheme(loadThemePreference())).toBe("dark");
  });

  it("treats an unknown stored value as no choice", () => {
    localStorage.setItem("bitterbot-theme", "sepia");
    expect(loadThemePreference()).toBe("system");
  });

  it("stores an explicit choice and paints it", () => {
    useUIStore.getState().setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("bitterbot-theme")).toBe("dark");
    expect(useUIStore.getState().theme).toBe("dark");

    useUIStore.getState().toggleTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(useUIStore.getState().themePreference).toBe("light");
  });

  it("goes back to following the system by clearing the stored choice", () => {
    useUIStore.getState().setTheme("light");
    stubSystem(true);
    useUIStore.getState().setTheme("system");

    expect(localStorage.getItem("bitterbot-theme")).toBeNull();
    expect(useUIStore.getState().themePreference).toBe("system");
    expect(useUIStore.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
