import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "./types.bitterbot.js";
import { applyCirclesDefaults, DEFAULT_CIRCLES_MAILBOX_URL } from "./defaults.js";

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

  it("ships a default fleet mailbox URL (PLAN-36 Phase 1)", () => {
    const out = applyCirclesDefaults({} as BitterbotConfig);
    expect(out.circles?.mailbox?.url).toBe(DEFAULT_CIRCLES_MAILBOX_URL);
  });

  it("lets a node override the default mailbox url and opt out", () => {
    const override = applyCirclesDefaults({
      circles: { mailbox: { url: "https://my-relay", serve: true } },
    } as BitterbotConfig);
    expect(override.circles?.mailbox?.url).toBe("https://my-relay");
    expect(override.circles?.mailbox?.serve).toBe(true);
    const off = applyCirclesDefaults({
      circles: { mailbox: { enabled: false } },
    } as BitterbotConfig);
    expect(off.circles?.mailbox?.enabled).toBe(false);
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
