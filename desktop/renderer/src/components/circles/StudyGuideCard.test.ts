import { describe, expect, it } from "vitest";
import { parseSections, sectionSlot } from "./StudyGuideCard";

// PLAN-36 C3: sectionSlot is the cross-node contract — every member's renderer
// must derive the SAME slot from the same section title with no coordination.
// These golden values pin the mapping; src/circles/service.test.ts uses them as
// literals, so a change here that isn't a deliberate (migration-bearing)
// breaking change is a bug.

describe("sectionSlot", () => {
  it("matches the pinned golden values (the cross-node contract)", () => {
    expect(sectionSlot("Glycolysis")).toBe("sec-b9b14b81");
    expect(sectionSlot("Krebs cycle")).toBe("sec-a34f5662");
    expect(sectionSlot("Electron transport")).toBe("sec-0806ea9e");
  });

  it("normalizes case, whitespace, and Unicode form (NFC vs NFD)", () => {
    expect(sectionSlot("  glycolysis  ")).toBe("sec-b9b14b81");
    expect(sectionSlot("GLYCOLYSIS")).toBe("sec-b9b14b81");
    // "Café" typed as a precomposed é vs e + combining accent — different
    // keyboards/IMEs emit different forms of the same title.
    expect(sectionSlot("Café")).toBe(sectionSlot("Café"));
    expect(sectionSlot("Café")).toBe("sec-3308be7c");
  });

  it("distinguishes genuinely different sections", () => {
    expect(sectionSlot("Glycolysis")).not.toBe(sectionSlot("Krebs cycle"));
  });
});

describe("parseSections", () => {
  it("splits lines, trims, drops empties, and dedupes by slot", () => {
    expect(parseSections("Glycolysis\n\n  Krebs cycle  \nglycolysis\n")).toEqual([
      "Glycolysis",
      "Krebs cycle",
    ]);
  });

  it("survives hostile all-newline card text", () => {
    expect(parseSections("\n".repeat(4000))).toEqual([]);
  });
});
