import { describe, expect, it } from "vitest";
import {
  CONTROL_SECTIONS,
  DEFAULT_CONTROL_TAB,
  isControlTab,
  NAV_MANIFEST,
  visibleNavItems,
} from "./nav-manifest";

describe("nav manifest", () => {
  it("gives every view exactly one place", () => {
    const ids = NAV_MANIFEST.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of NAV_MANIFEST) {
      expect(["sidebar", "control"], item.id).toContain(item.place);
    }
  });

  it("puts every Control Center view in a known section, and only those", () => {
    const sections = CONTROL_SECTIONS.map((s) => s.id as string);
    for (const item of NAV_MANIFEST) {
      if (item.place === "control") expect(sections, item.id).toContain(item.section);
      else expect(item.section, item.id).toBeUndefined();
    }
    // No section is left empty.
    for (const section of sections) {
      expect(
        NAV_MANIFEST.some((item) => item.section === section),
        section,
      ).toBe(true);
    }
  });

  it("keeps the sidebar to the person's own work", () => {
    const sidebar = NAV_MANIFEST.filter((item) => item.place === "sidebar").map((i) => i.label);
    expect(sidebar).toEqual(["Memory", "Automations", "Files", "Circles"]);
  });

  it("opens the Control Center on a control view", () => {
    expect(isControlTab(DEFAULT_CONTROL_TAB)).toBe(true);
    expect(isControlTab("chat")).toBe(false);
    expect(isControlTab("memory")).toBe(false);
  });

  it("hides views the gateway does not offer", () => {
    expect(visibleNavItems([]).some((item) => item.id === "management")).toBe(false);
    expect(visibleNavItems(["management"]).some((item) => item.id === "management")).toBe(true);
  });
});
