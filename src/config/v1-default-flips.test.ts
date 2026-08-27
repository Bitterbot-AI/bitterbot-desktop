/**
 * PLAN-41 D-D (adjudicated 2026-08-26): experimental / network-dialing /
 * money-adjacent surfaces are OPT-IN for V1. One assertion per flipped flag
 * where the gate is cheaply reachable; the heavier manager-internal gates
 * (skillSeekers adapter + trending sweep, harnessEvolve, architectEvolution,
 * forage.audit) are exercised by their subsystem suites, which now opt in
 * explicitly. Circles deliberately stays ON (Victor's call) — see the plan.
 */
import { describe, expect, it } from "vitest";
import type { BitterbotConfig } from "./types.bitterbot.js";
import { createSkillSeekersIngestTool } from "../agents/tools/skill-seekers-tool.js";
import { createWalletTool } from "../agents/tools/wallet-tool.js";
import { MemoryIndexManager } from "../memory/manager.js";
import { applyA2aDefaults } from "./defaults.js";

describe("V1 default flips (PLAN-41 D-D)", () => {
  it("a2a.enabled defaults OFF", () => {
    expect(applyA2aDefaults({}).a2a?.enabled).toBe(false);
  });

  it("a2a.enabled explicit opt-in is honored", () => {
    expect(applyA2aDefaults({ a2a: { enabled: true } }).a2a?.enabled).toBe(true);
  });

  it("a2a.marketplace.enabled defaults OFF", () => {
    expect(applyA2aDefaults({}).a2a?.marketplace?.enabled).toBe(false);
    expect(
      applyA2aDefaults({ a2a: { marketplace: { enabled: true } } }).a2a?.marketplace?.enabled,
    ).toBe(true);
  });

  it("tools.wallet is opt-in: no wallet tool without enabled=true", () => {
    expect(createWalletTool({ config: {} as BitterbotConfig })).toBeUndefined();
    expect(
      createWalletTool({ config: { tools: { wallet: { enabled: false } } } as BitterbotConfig }),
    ).toBeUndefined();
    expect(
      createWalletTool({ config: { tools: { wallet: { enabled: true } } } as BitterbotConfig }),
    ).toBeDefined();
  });

  it("skills.skillSeekers is opt-in: no ingest tool by default", () => {
    expect(createSkillSeekersIngestTool({ config: {} as BitterbotConfig })).toBeNull();
    expect(
      createSkillSeekersIngestTool({
        config: { skills: { skillSeekers: { enabled: true } } } as BitterbotConfig,
      }),
    ).not.toBeNull();
  });

  it("skills.marketability.predictor is opt-in: resolves to null by default", async () => {
    // The gate reads only this.cfg before touching the db, so a bare
    // prototype-carrying manager suffices (same trick as cognition-health).
    const mgr = Object.assign(Object.create(MemoryIndexManager.prototype) as object, {
      cfg: {},
    }) as unknown as MemoryIndexManager;
    await expect(mgr.getMarketabilityPredictor()).resolves.toBeNull();
  });
});
