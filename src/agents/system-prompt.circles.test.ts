import { describe, expect, it } from "vitest";
import { buildCirclesSection } from "./system-prompt.js";

// PLAN-31: the Circles system-prompt fragment is gated on the `circles` tool
// being available (which only registers when circles.enabled, ON by default).
// Present only when the capability is live.

describe("buildCirclesSection", () => {
  it("is empty when the circles tool is not available (circles disabled)", () => {
    expect(buildCirclesSection(new Set())).toEqual([]);
    expect(buildCirclesSection(new Set(["forage", "wallet"]))).toEqual([]);
  });

  it("emits the fragment when the circles tool is available", () => {
    const text = buildCirclesSection(new Set(["circles"])).join("\n");
    expect(text).toContain("### Circles");
    // Tells the agent to use the tool, not guess.
    expect(text).toMatch(/call the `circles` tool/);
    // The human-gated two-phase write rule is stated.
    expect(text).toMatch(/TWO-PHASE/);
    expect(text).toMatch(/confirm=true/);
    expect(text).toMatch(/Never confirm on your own/i);
    // The no-money and no-invite invariants are stated.
    expect(text).toMatch(/No money moves/i);
    expect(text).toMatch(/cannot mint invites|People pane/i);
  });
});
