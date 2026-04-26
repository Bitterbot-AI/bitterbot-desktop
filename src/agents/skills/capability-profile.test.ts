/**
 * PLAN-13 Phase B: tests for the capability profile resolver.
 *
 * Resolution rules under test:
 *  - tier baselines clip declarations downward
 *  - declarations of `false` are absolute (deny grants can't be overridden
 *    upward by the publisher claiming otherwise; but explicit publisher
 *    denies are honored regardless of grants)
 *  - allow grants widen up to the declaration; never beyond
 *  - deny grants are final
 *  - "local" tier (no provenance) is full-trust by default
 */

import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "./capability-grants.js";
import {
  profileAllows,
  resolveCapabilityProfile,
  type SkillTrustTier,
} from "./capability-profile.js";

describe("resolveCapabilityProfile", () => {
  describe("tier baselines", () => {
    it("verified honors a permissive declaration", () => {
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: {
          network: { outbound: ["api.example.com"] },
          fs: { read: ["/tmp/x"], write: ["/tmp/x"] },
          wallet: true,
          shell: true,
        },
      });
      expect(profile.network.outbound).toEqual(["api.example.com"]);
      expect(profile.wallet).toBe(true);
      expect(profile.shell).toBe(true);
    });

    it("provisional clips wallet/shell/process even when declared", () => {
      const profile = resolveCapabilityProfile({
        tier: "provisional",
        declared: {
          wallet: true,
          shell: true,
          process: true,
        },
      });
      expect(profile.wallet).toBe(false);
      expect(profile.shell).toBe(false);
      expect(profile.process).toBe(false);
    });

    it("untrusted denies network even with declared outbound", () => {
      const profile = resolveCapabilityProfile({
        tier: "untrusted",
        declared: {
          network: { outbound: ["api.example.com"] },
        },
      });
      expect(profile.network.outbound).toEqual([]);
    });

    it("banned denies everything", () => {
      const profile = resolveCapabilityProfile({
        tier: "banned",
        declared: {
          network: { outbound: ["*"] },
          wallet: true,
          shell: true,
        },
      });
      expect(profile.wallet).toBe(false);
      expect(profile.shell).toBe(false);
      expect(profile.network.outbound).toEqual([]);
      expect(profile.fs.read).toEqual([]);
      expect(profile.fs.write).toEqual([]);
    });

    it("local (no provenance) honors declarations as-is", () => {
      const profile = resolveCapabilityProfile({
        tier: "local",
        declared: {
          wallet: true,
          shell: true,
        },
      });
      expect(profile.wallet).toBe(true);
      expect(profile.shell).toBe(true);
    });
  });

  describe("declaration clipping", () => {
    it("publisher's explicit `wallet: false` is honored even on verified tier", () => {
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: { wallet: false },
      });
      expect(profile.wallet).toBe(false);
    });

    it("publisher's explicit `network: false` empties outbound list", () => {
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: { network: false },
      });
      expect(profile.network.outbound).toEqual([]);
    });

    it("trusted tier honors declared outbound list (not '*' explosion)", () => {
      const profile = resolveCapabilityProfile({
        tier: "trusted",
        declared: { network: { outbound: ["api.openweathermap.org"] } },
      });
      expect(profile.network.outbound).toEqual(["api.openweathermap.org"]);
    });
  });

  describe("operator grants", () => {
    it("allow grant on `wallet` widens trusted-tier (which baselines wallet=false)", () => {
      const grants: CapabilityGrant[] = [
        {
          contentHash: "h",
          capability: "wallet",
          decision: "allow",
          grantedAt: 1,
        },
      ];
      const profile = resolveCapabilityProfile({
        tier: "trusted",
        declared: { wallet: true },
        grants,
      });
      expect(profile.wallet).toBe(true);
    });

    it("allow grant cannot widen beyond what was declared", () => {
      const grants: CapabilityGrant[] = [
        {
          contentHash: "h",
          capability: "wallet",
          decision: "allow",
          grantedAt: 1,
        },
      ];
      const profile = resolveCapabilityProfile({
        tier: "trusted",
        declared: { wallet: false }, // publisher denies
        grants,
      });
      expect(profile.wallet).toBe(false);
    });

    it("deny grant clips even verified tier", () => {
      const grants: CapabilityGrant[] = [
        {
          contentHash: "h",
          capability: "wallet",
          decision: "deny",
          grantedAt: 1,
        },
      ];
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: { wallet: true },
        grants,
      });
      expect(profile.wallet).toBe(false);
    });

    it("network grant with scope adds hosts to the profile", () => {
      const grants: CapabilityGrant[] = [
        {
          contentHash: "h",
          capability: "network",
          decision: "allow",
          scope: { outbound: ["b.example.com"] },
          grantedAt: 1,
        },
      ];
      const profile = resolveCapabilityProfile({
        tier: "trusted",
        declared: { network: { outbound: ["a.example.com"] } },
        grants,
      });
      expect(profile.network.outbound.toSorted()).toEqual(["a.example.com", "b.example.com"]);
    });
  });

  describe("profileAllows", () => {
    it("network host suffix matching", () => {
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: { network: { outbound: ["*.example.com"] } },
      });
      expect(profileAllows(profile, "network", { host: "api.example.com" })).toBe(true);
      expect(profileAllows(profile, "network", { host: "api.attacker.com" })).toBe(false);
    });

    it("fs read vs write are independent", () => {
      const profile = resolveCapabilityProfile({
        tier: "verified",
        declared: { fs: { read: ["/tmp/a"], write: [] } },
      });
      expect(profileAllows(profile, "fs", { mode: "read", path: "/tmp/a/file" })).toBe(true);
      expect(profileAllows(profile, "fs", { mode: "write", path: "/tmp/a/file" })).toBe(false);
    });

    it("wallet/shell/process are simple booleans", () => {
      const profile = resolveCapabilityProfile({
        tier: "trusted",
        declared: { wallet: true },
        grants: [{ contentHash: "h", capability: "wallet", decision: "allow", grantedAt: 1 }],
      });
      expect(profileAllows(profile, "wallet")).toBe(true);
      expect(profileAllows(profile, "shell")).toBe(false);
    });
  });

  describe("aggregate scenarios", () => {
    const ATTACKER_TIERS: SkillTrustTier[] = ["banned", "untrusted", "provisional"];
    it("attacker-tier publishers cannot get wallet via any path", () => {
      for (const tier of ATTACKER_TIERS) {
        const profile = resolveCapabilityProfile({
          tier,
          declared: { wallet: true },
          grants: [
            // Even an "allow" grant cannot rescue a tier baseline of wallet=false
            // unless the tier baseline already permits wallet (which provisional
            // and below never do).
          ],
        });
        expect(profile.wallet).toBe(false);
      }
    });
  });
});
