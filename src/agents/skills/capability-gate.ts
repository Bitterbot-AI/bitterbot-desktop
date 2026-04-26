/**
 * PLAN-13 Phase B: load-time capability gate for ingested skills.
 *
 * Decides whether a skill should reach the active prompt at all. A skill
 * whose declared capabilities exceed its trust tier (after operator grants
 * are applied) is excluded from the LLM's view. This is the conservative,
 * shippable half of Phase B; the dispatch-time runtime enforcer (which
 * needs to attribute a tool call back to a specific active skill — a
 * non-trivial problem at the LLM boundary) is filed as follow-up.
 *
 * The gate is a pure function. Wiring it into the loader is opt-in: a
 * caller that wants to enforce passes a `CapabilityGateContext` with
 * trust-tier + grants providers. Without it, behavior is unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import type { SkillCapabilitiesDeclaration, SkillEntry } from "./types.js";
import { type CapabilityAxis, type CapabilityGrant } from "./capability-grants.js";
import {
  type EffectiveCapabilityProfile,
  type SkillTrustTier,
  resolveCapabilityProfile,
} from "./capability-profile.js";

export type SkillProvenance = {
  authorPubkey: string;
  contentHash: string;
  authorPeerId?: string;
  ingestedAt?: number;
};

export type CapabilityGateContext = {
  /** Resolve a publisher's trust tier. Locally-authored skills get "local". */
  getTrustTier: (pubkey: string) => SkillTrustTier;
  /** Look up persisted operator grants for a content hash. */
  getGrants?: (contentHash: string) => CapabilityGrant[];
};

export type CapabilityGateVerdict =
  | { ok: true; effectiveProfile: EffectiveCapabilityProfile; tier: SkillTrustTier }
  | {
      ok: false;
      reason: string;
      blockedAxes: CapabilityAxis[];
      tier: SkillTrustTier;
      effectiveProfile: EffectiveCapabilityProfile;
    };

/**
 * Read the `.provenance.json` file written by the P2P ingest pipeline.
 * Returns `null` for skills with no provenance (locally-authored, bundled,
 * or imported via a non-P2P route).
 */
export function loadSkillProvenance(skill: { baseDir?: string | null }): SkillProvenance | null {
  if (!skill.baseDir) return null;
  const provenancePath = path.join(skill.baseDir, ".provenance.json");
  try {
    if (!fs.existsSync(provenancePath)) return null;
    const raw = fs.readFileSync(provenancePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.author_pubkey !== "string" || typeof parsed.content_hash !== "string") {
      return null;
    }
    return {
      authorPubkey: parsed.author_pubkey,
      contentHash: parsed.content_hash,
      authorPeerId: typeof parsed.author_peer_id === "string" ? parsed.author_peer_id : undefined,
      ingestedAt: typeof parsed.ingested_at === "number" ? parsed.ingested_at : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate whether a skill should be admitted to the active prompt.
 *
 * The check is: the resolved profile must be non-empty in every axis the
 * skill explicitly declared as allowed. If the skill says "I need wallet"
 * but the resolver returns `wallet: false`, that axis was clipped by the
 * tier (or by an explicit deny grant), and the skill should not reach the
 * LLM — its body will reference a tool it cannot use, which both fails the
 * skill and creates a confusion-level vector for the LLM to be coaxed
 * into trying anyway.
 */
export function evaluateSkillCapabilities(
  entry: SkillEntry,
  ctx: CapabilityGateContext,
): CapabilityGateVerdict {
  const provenance = loadSkillProvenance(entry.skill);
  const tier: SkillTrustTier = provenance ? ctx.getTrustTier(provenance.authorPubkey) : "local";
  const grants = provenance && ctx.getGrants ? ctx.getGrants(provenance.contentHash) : [];
  const declared = entry.metadata?.capabilities;
  const effectiveProfile = resolveCapabilityProfile({ declared, tier, grants });

  // Banned tier always blocks.
  if (tier === "banned") {
    return {
      ok: false,
      reason: "publisher is banned",
      blockedAxes: collectAllDeclaredAxes(declared),
      tier,
      effectiveProfile,
    };
  }

  // No declarations means no axes to over-claim. Allow.
  if (!declared) {
    return { ok: true, effectiveProfile, tier };
  }

  const blockedAxes = compareDeclarationAgainstProfile(declared, effectiveProfile);

  if (blockedAxes.length === 0) {
    return { ok: true, effectiveProfile, tier };
  }

  return {
    ok: false,
    reason: `tier=${tier} clips declared capabilities: ${blockedAxes.join(", ")}`,
    blockedAxes,
    tier,
    effectiveProfile,
  };
}

function collectAllDeclaredAxes(decl?: SkillCapabilitiesDeclaration): CapabilityAxis[] {
  if (!decl) return [];
  const axes: CapabilityAxis[] = [];
  if (decl.network !== undefined) axes.push("network");
  if (decl.fs !== undefined) axes.push("fs");
  if (decl.wallet !== undefined) axes.push("wallet");
  if (decl.shell !== undefined) axes.push("shell");
  if (decl.process !== undefined) axes.push("process");
  return axes;
}

/**
 * For each axis the declaration claimed allowed, check the effective
 * profile permits it. Return the list of axes the tier clipped away.
 */
function compareDeclarationAgainstProfile(
  decl: SkillCapabilitiesDeclaration,
  profile: EffectiveCapabilityProfile,
): CapabilityAxis[] {
  const blocked: CapabilityAxis[] = [];

  if (decl.network && typeof decl.network === "object") {
    const declared = decl.network.outbound ?? [];
    if (declared.length > 0 && profile.network.outbound.length === 0) {
      blocked.push("network");
    }
  }

  if (decl.fs && typeof decl.fs === "object") {
    const declRead = decl.fs.read ?? [];
    const declWrite = decl.fs.write ?? [];
    if (
      (declRead.length > 0 && profile.fs.read.length === 0) ||
      (declWrite.length > 0 && profile.fs.write.length === 0)
    ) {
      blocked.push("fs");
    }
  }

  if (decl.wallet === true && profile.wallet === false) blocked.push("wallet");
  if (decl.shell === true && profile.shell === false) blocked.push("shell");
  if (decl.process === true && profile.process === false) blocked.push("process");

  return blocked;
}

/**
 * Bulk-evaluate a list of entries. Returns the entries that pass the gate
 * plus a structured report of every block (for logs and the operator UX).
 */
export function applyCapabilityGate(
  entries: SkillEntry[],
  ctx: CapabilityGateContext,
): {
  permitted: SkillEntry[];
  blocked: Array<{ entry: SkillEntry; verdict: CapabilityGateVerdict }>;
} {
  const permitted: SkillEntry[] = [];
  const blocked: Array<{ entry: SkillEntry; verdict: CapabilityGateVerdict }> = [];
  for (const entry of entries) {
    const verdict = evaluateSkillCapabilities(entry, ctx);
    if (verdict.ok) {
      permitted.push(entry);
    } else {
      blocked.push({ entry, verdict });
    }
  }
  return { permitted, blocked };
}
