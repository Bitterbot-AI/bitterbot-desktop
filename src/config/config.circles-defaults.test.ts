import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "./types.bitterbot.js";
import { applyCirclesDefaults } from "./defaults.js";

// PLAN-31 red-team phase (2026-07-09): circles are ON BY DEFAULT fleet-wide
// so the connection surface can be tested/attacked at scale. A wrong default
// here either leaves the whole fleet dark (nothing to red-team) or ignores an
// operator's explicit opt-out, so both directions are pinned.

describe("applyCirclesDefaults", () => {
  it("defaults enabled=true when circles is unset (on by default)", () => {
    const out = applyCirclesDefaults({} as BitterbotConfig);
    expect(out.circles?.enabled).toBe(true);
    expect(out.circles?.briefing?.enabled).toBe(true);
    expect(out.circles?.practicePartner?.enabled).toBe(true);
  });

  it("defaults enabled=true when circles is present but enabled is unset", () => {
    const out = applyCirclesDefaults({ circles: { a2aPublicUrl: "https://x" } } as BitterbotConfig);
    expect(out.circles?.enabled).toBe(true);
    expect(out.circles?.a2aPublicUrl).toBe("https://x");
  });

  it("honors an explicit opt-out (enabled=false stays false)", () => {
    const out = applyCirclesDefaults({ circles: { enabled: false } } as BitterbotConfig);
    expect(out.circles?.enabled).toBe(false);
  });

  it("preserves explicitly-set fields and sub-object overrides", () => {
    const out = applyCirclesDefaults({
      circles: {
        enabled: true,
        displayName: "Bitterbot-Prime",
        mailbox: { url: "https://relay", serve: true },
        briefing: { enabled: false },
      },
    } as BitterbotConfig);
    expect(out.circles?.displayName).toBe("Bitterbot-Prime");
    expect(out.circles?.mailbox?.serve).toBe(true);
    expect(out.circles?.briefing?.enabled).toBe(false); // explicit override wins
    expect(out.circles?.practicePartner?.enabled).toBe(true); // still defaulted
  });
});
