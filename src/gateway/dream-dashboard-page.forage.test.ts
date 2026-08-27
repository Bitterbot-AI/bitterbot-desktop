import { describe, expect, it } from "vitest";
import { renderDreamDashboardPage } from "./dream-dashboard-page.js";

// PLAN-29 Phase 3b: the Forage tab renders in the dream dashboard with its
// scoreboard, tape container, and the DPSV honesty note, and the loader is
// wired into tab dispatch.

describe("dream dashboard Forage tab", () => {
  const page = renderDreamDashboardPage("ws://127.0.0.1:19001", "/auth/session-token", {
    showForage: true,
    showEarnings: true,
  });

  it("embeds no gateway token — session-token handoff only (PLAN-41 mgmt-token-html)", () => {
    expect(page).toContain("fetchSessionToken");
    expect(page).toContain('let GW_TOKEN = ""');
    expect(page).not.toMatch(/const GW_TOKEN = "[^"]+"/);
  });

  it("renders the tab button and panel", () => {
    expect(page).toContain('data-tab="forage"');
    expect(page).toContain('id="panel-forage"');
    expect(page).toContain('id="forage-stats"');
    expect(page).toContain('id="forage-tape"');
  });

  it("wires the loader into tab dispatch and calls both RPCs", () => {
    expect(page).toContain("loadForage()");
    expect(page).toContain("rpc('forage.stats')");
    expect(page).toContain("rpc('forage.tape'");
  });

  it("carries the DPSV honesty note instead of a GMV number", () => {
    expect(page).toContain("Distinct-Party Settled Value");
    expect(page).toContain("no raw GMV");
  });
});

describe("dream dashboard tab gating (PLAN-41 p0-14)", () => {
  it("omits Earnings and Forage tabs when their backends are off (the default)", () => {
    const page = renderDreamDashboardPage("ws://127.0.0.1:19001");
    expect(page).not.toContain('data-tab="earnings"');
    expect(page).not.toContain('data-tab="forage"');
    expect(page).not.toContain('id="panel-forage"');
    // The always-on tabs are unaffected.
    expect(page).toContain('data-tab="status"');
    expect(page).toContain('data-tab="live"');
  });

  it("carries no lab jargon or dead review queue", () => {
    const page = renderDreamDashboardPage("ws://127.0.0.1:19001");
    for (const banned of ["D1 pilot", "PLAN-33", "PLAN-34", "PLAN-40", "GCCRF", "SABM"]) {
      expect(page).not.toContain(banned);
    }
    expect(page).not.toContain("utility-review");
    expect(page).not.toContain("Hormonal State");
  });
});
