/**
 * PLAN-43 Phase 3 config surface: a2a.attestation (exchange + weighting)
 * and skills.agentskills.royaltyWallet validate with sane bounds.
 */

import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("a2a.attestation + registry royalty config", () => {
  it("accepts the documented shape", () => {
    const r = validateConfigObject({
      a2a: {
        attestation: {
          enabled: true,
          peers: ["https://peer.example"],
          trustedAttesters: [`ed25519:${"a".repeat(64)}`],
          blockedAttesters: [],
          unknownAttesterWeight: 0.05,
        },
      },
      skills: {
        agentskills: { royaltyBps: 500, royaltyWallet: `0x${"1".repeat(40)}` },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.a2a?.attestation?.unknownAttesterWeight).toBe(0.05);
      expect(r.config.skills?.agentskills?.royaltyWallet).toBe(`0x${"1".repeat(40)}`);
    }
  });

  it("rejects out-of-range weights and malformed wallets", () => {
    expect(validateConfigObject({ a2a: { attestation: { unknownAttesterWeight: 1.5 } } }).ok).toBe(
      false,
    );
    expect(
      validateConfigObject({ skills: { agentskills: { royaltyWallet: "not-an-address" } } }).ok,
    ).toBe(false);
  });
});
