import { describe, expect, it } from "vitest";
import { BrowserToolView } from "./BrowserToolView";
import { CommandToolView } from "./CommandToolView";
import { GenericToolView } from "./GenericToolView";
import { getToolView } from "./ToolViewRegistry";

describe("getToolView", () => {
  it("shows the agent's real shell tools in the terminal view", () => {
    // `exec` contains neither "command" nor "execute", so it used to get the
    // generic JSON view and the pane had no terminal at all.
    expect(getToolView("exec")).toBe(CommandToolView);
    expect(getToolView("process")).toBe(CommandToolView);
    expect(getToolView("bash")).toBe(CommandToolView);
  });

  it("shows the browser tool in the browser view", () => {
    expect(getToolView("browser")).toBe(BrowserToolView);
  });

  it("falls back to the generic view for tools it does not know", () => {
    expect(getToolView("wallet")).toBe(GenericToolView);
  });
});
