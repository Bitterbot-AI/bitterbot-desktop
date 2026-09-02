/**
 * PLAN-43 Phase 1: exact-ID skill attribution and per-skill payment
 * amounts. Fuzzy name-matching from task text is banned (§3.4 slopsquat);
 * a named skill must be paid at its listed price, not the floor.
 */

import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { MarketplaceEconomics } from "../../memory/marketplace-economics.js";
import { resolveRequestedSkillId, verifyA2aPayment } from "./payment.js";

function reqWithoutPayment(): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = {};
  return req;
}

const stubMarketplace = {
  getListableSkills: () => [
    { skillCrystalId: "skill-1", name: "Expensive Skill", priceUsdc: 0.25 },
  ],
} as unknown as MarketplaceEconomics;

describe("resolveRequestedSkillId", () => {
  it("reads the explicit param, then metadata, never the message text", () => {
    expect(resolveRequestedSkillId({ skillId: "abc" })).toBe("abc");
    expect(resolveRequestedSkillId({ metadata: { skillId: "meta-id" } })).toBe("meta-id");
    expect(resolveRequestedSkillId({ skillId: " padded " })).toBe("padded");
    expect(resolveRequestedSkillId({})).toBeUndefined();
    expect(resolveRequestedSkillId(undefined)).toBeUndefined();
    expect(resolveRequestedSkillId({ metadata: { skillId: 42 as never } })).toBeUndefined();
  });
});

describe("verifyA2aPayment pricing", () => {
  it("prices an unpaid request at the skill's per-call price, not the floor", async () => {
    const result = await verifyA2aPayment(
      reqWithoutPayment(),
      { a2a: { payment: { enabled: true, x402: { minPayment: 0.01 } } } } as never,
      stubMarketplace,
      { skillId: "skill-1" },
      { requiredAmountUsdc: 0.25 },
    );
    expect(result.paid).toBe(false);
    expect(result.pricing?.priceUsdc).toBe(0.25);
  });

  it("never prices below the configured minimum", async () => {
    const result = await verifyA2aPayment(
      reqWithoutPayment(),
      { a2a: { payment: { enabled: true, x402: { minPayment: 0.05 } } } } as never,
      stubMarketplace,
      {},
      { requiredAmountUsdc: 0.001 },
    );
    expect(result.pricing?.priceUsdc).toBe(0.05);
  });
});
