/**
 * PLAN-13 Phase B: capability profile resolution.
 *
 * Combines a skill's declared capabilities, the publisher's trust tier, and
 * persisted operator grants into a single `EffectiveCapabilityProfile` that
 * the dispatch enforcer can check against.
 *
 * Resolution order (each step caps the previous):
 *
 *   1. Locally-authored skill (no .provenance.json) -> full-trust default,
 *      honors any explicit denies in the declaration.
 *
 *   2. Ingested skill -> start from the trust-tier baseline (banned <
 *      untrusted < provisional < trusted < verified). Each tier defines an
 *      upper bound on what's allowed regardless of declaration.
 *
 *   3. Skill declarations clip the tier baseline downward (a `verified`
 *      publisher who voluntarily declares `wallet: false` gets `wallet: false`).
 *
 *   4. Operator grants override declarations and tier baselines on the allow
 *      side, but a `deny` grant is final.
 *
 * The result is a strict "what the LLM is actually allowed to do for this
 * skill," not a rendering of intentions.
 */

import type { CapabilityAxis, CapabilityGrant } from "./capability-grants.js";
import type { SkillCapabilitiesDeclaration } from "./types.js";

export type SkillTrustTier =
  | "verified"
  | "trusted"
  | "provisional"
  | "untrusted"
  | "banned"
  | "local";

export type EffectiveCapabilityProfile = {
  network: { outbound: string[] };
  fs: { read: string[]; write: string[] };
  wallet: boolean;
  shell: boolean;
  process: boolean;
};

export type ResolveProfileInput = {
  /** Parsed `bitterbot.capabilities` block; undefined if absent. */
  declared?: SkillCapabilitiesDeclaration;
  /** Trust tier for the publisher (or "local" for skills with no provenance). */
  tier: SkillTrustTier;
  /** Operator decisions persisted in `skill_capability_grants`. */
  grants?: CapabilityGrant[];
};

const TIER_ORDER: SkillTrustTier[] = [
  "banned",
  "untrusted",
  "provisional",
  "trusted",
  "verified",
  "local",
];

/**
 * Per-tier upper bound on each capability axis. The resolver clips any
 * declaration above this. `local` (no provenance) is treated as full trust;
 * `banned` denies everything (the skill should not have loaded).
 */
const TIER_BASELINE: Record<SkillTrustTier, EffectiveCapabilityProfile> = {
  banned: {
    network: { outbound: [] },
    fs: { read: [], write: [] },
    wallet: false,
    shell: false,
    process: false,
  },
  untrusted: {
    network: { outbound: [] },
    fs: { read: ["${SKILL_WORKSPACE}/"], write: ["${SKILL_WORKSPACE}/"] },
    wallet: false,
    shell: false,
    process: false,
  },
  provisional: {
    network: { outbound: [] }, // declarations may grant; baseline is empty
    fs: { read: ["${SKILL_WORKSPACE}/"], write: ["${SKILL_WORKSPACE}/"] },
    wallet: false,
    shell: false,
    process: false,
  },
  trusted: {
    network: { outbound: ["*"] }, // honor declared list; "*" placeholder for "any declared"
    fs: { read: ["*"], write: ["*"] },
    wallet: false, // requires operator grant
    shell: false, // requires operator grant
    process: false, // requires operator grant
  },
  verified: {
    network: { outbound: ["*"] },
    fs: { read: ["*"], write: ["*"] },
    wallet: true,
    shell: true,
    process: true,
  },
  local: {
    network: { outbound: ["*"] },
    fs: { read: ["*"], write: ["*"] },
    wallet: true,
    shell: true,
    process: true,
  },
};

/**
 * Compute the effective profile for a skill at execution time.
 */
export function resolveCapabilityProfile(input: ResolveProfileInput): EffectiveCapabilityProfile {
  const baseline = TIER_BASELINE[input.tier] ?? TIER_BASELINE.untrusted;
  const profile: EffectiveCapabilityProfile = {
    network: { outbound: [...baseline.network.outbound] },
    fs: { read: [...baseline.fs.read], write: [...baseline.fs.write] },
    wallet: baseline.wallet,
    shell: baseline.shell,
    process: baseline.process,
  };

  // Apply declarations as a downward clip.
  const decl = input.declared;
  if (decl) {
    if (decl.network === false) {
      profile.network = { outbound: [] };
    } else if (decl.network && typeof decl.network === "object") {
      const declared = decl.network.outbound ?? [];
      profile.network = {
        outbound: intersectHosts(profile.network.outbound, declared),
      };
    }

    if (decl.fs === false) {
      profile.fs = { read: [], write: [] };
    } else if (decl.fs && typeof decl.fs === "object") {
      const declRead = decl.fs.read ?? [];
      const declWrite = decl.fs.write ?? [];
      profile.fs = {
        read: intersectPaths(profile.fs.read, declRead),
        write: intersectPaths(profile.fs.write, declWrite),
      };
    }

    if (decl.wallet === false) profile.wallet = false;
    if (decl.shell === false) profile.shell = false;
    if (decl.process === false) profile.process = false;
    // Note: `decl.<axis> === true` does NOT widen a tier baseline. The tier
    // is the upper bound; declarations only narrow.
  }

  // Apply operator grants. Allow grants widen up to the declaration; deny
  // grants are final and clip down regardless.
  for (const grant of input.grants ?? []) {
    applyGrant(profile, grant, decl);
  }

  return profile;
}

/**
 * Hosts: special "*" sentinel means "anything in the smaller set." If the
 * tier permits "*" but the declaration lists specific hosts, intersect
 * resolves to the declared list. If both sides are explicit, intersect.
 */
function intersectHosts(tierHosts: string[], declaredHosts: string[]): string[] {
  if (tierHosts.includes("*")) {
    return [...declaredHosts];
  }
  return tierHosts.filter((h) => declaredHosts.includes(h));
}

function intersectPaths(tierPaths: string[], declaredPaths: string[]): string[] {
  if (tierPaths.includes("*")) {
    return [...declaredPaths];
  }
  return tierPaths.filter((p) => declaredPaths.includes(p));
}

function applyGrant(
  profile: EffectiveCapabilityProfile,
  grant: CapabilityGrant,
  decl?: SkillCapabilitiesDeclaration,
): void {
  if (grant.decision === "deny") {
    // Deny grants are absolute.
    switch (grant.capability) {
      case "network":
        profile.network = { outbound: [] };
        return;
      case "fs":
        profile.fs = { read: [], write: [] };
        return;
      case "wallet":
        profile.wallet = false;
        return;
      case "shell":
        profile.shell = false;
        return;
      case "process":
        profile.process = false;
        return;
    }
  }

  // Allow grants only widen up to what the declaration permitted. We
  // refuse to grant something the publisher never asked for.
  switch (grant.capability) {
    case "network": {
      if (decl?.network === false) return;
      const declaredOutbound =
        decl?.network && typeof decl.network === "object" ? (decl.network.outbound ?? []) : [];
      const grantHosts = Array.isArray(grant.scope?.outbound)
        ? (grant.scope.outbound as string[])
        : declaredOutbound;
      profile.network = {
        outbound: Array.from(new Set([...profile.network.outbound, ...grantHosts])),
      };
      return;
    }
    case "fs": {
      if (decl?.fs === false) return;
      const dRead = decl?.fs && typeof decl.fs === "object" ? (decl.fs.read ?? []) : [];
      const dWrite = decl?.fs && typeof decl.fs === "object" ? (decl.fs.write ?? []) : [];
      const gRead = Array.isArray(grant.scope?.read) ? (grant.scope.read as string[]) : dRead;
      const gWrite = Array.isArray(grant.scope?.write) ? (grant.scope.write as string[]) : dWrite;
      profile.fs = {
        read: Array.from(new Set([...profile.fs.read, ...gRead])),
        write: Array.from(new Set([...profile.fs.write, ...gWrite])),
      };
      return;
    }
    case "wallet":
      if (decl?.wallet === false) return;
      profile.wallet = true;
      return;
    case "shell":
      if (decl?.shell === false) return;
      profile.shell = true;
      return;
    case "process":
      if (decl?.process === false) return;
      profile.process = true;
      return;
  }
}

/**
 * Convenience: ordered tier rank for a UI that wants to display the tier
 * gauge. Banned == 0, local == 5.
 */
export function tierRank(tier: SkillTrustTier): number {
  return Math.max(0, TIER_ORDER.indexOf(tier));
}

/**
 * Convenience: does this profile permit the given capability call?
 *
 * Hosts are matched as suffix-match for now (api.example.com matches
 * "api.example.com" and "*.example.com"); we'll tighten to a real glob
 * matcher when the enforcer needs more granularity.
 */
export function profileAllows(
  profile: EffectiveCapabilityProfile,
  capability: CapabilityAxis,
  scope?: { host?: string; path?: string; mode?: "read" | "write" },
): boolean {
  switch (capability) {
    case "network": {
      if (profile.network.outbound.length === 0) return false;
      if (!scope?.host) return profile.network.outbound.length > 0;
      return profile.network.outbound.some((h) => hostMatches(h, scope.host!));
    }
    case "fs": {
      const list = scope?.mode === "write" ? profile.fs.write : profile.fs.read;
      if (list.length === 0) return false;
      if (!scope?.path) return true;
      return list.some((p) => pathMatches(p, scope.path!));
    }
    case "wallet":
      return profile.wallet;
    case "shell":
      return profile.shell;
    case "process":
      return profile.process;
  }
}

function hostMatches(allowed: string, candidate: string): boolean {
  if (allowed === "*") return true;
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1); // ".example.com"
    return candidate.endsWith(suffix);
  }
  return allowed === candidate;
}

function pathMatches(allowed: string, candidate: string): boolean {
  if (allowed === "*") return true;
  // Prefix match: allowed=/foo/ matches /foo/bar.txt; SKILL_WORKSPACE
  // placeholder is opaque to this matcher (caller is responsible for
  // expanding it before invoking).
  return candidate.startsWith(allowed);
}
