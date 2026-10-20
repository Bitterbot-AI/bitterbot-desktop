import { beforeEach, describe, expect, it } from "vitest";
import {
  clampToolPanelWidth,
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
