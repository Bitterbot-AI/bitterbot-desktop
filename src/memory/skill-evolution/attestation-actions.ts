/**
 * PLAN-45 4.3 (D-4): attestations become actionable.
 *
 * A live peer skill is demoted to CANARY-OFF (withheld from every run,
 * files kept, reversible) when this node's own re-score found a regression,
 * or when at least two TRUSTED attesters (a2a.attestation.trustedAttesters,
 * weight 1) did. Unknown attesters never demote: device identities are
 * free to mint. The same staleness and corpus-generation filters the
 * aggregate uses apply, so a 91-day-old or previous-generation verdict
 * cannot demote. Split out of attestation.ts (500-line cap).
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { canaryOff, isCanaryOff, readCanaryRegistry } from "../../agents/skills/canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  ATTESTATION_MAX_AGE_MS,
  currentAttestationCorpusPrefix,
  listAttestations,
  type SkillAttestation,
  skillContentSha256,
} from "./attestation.js";
import { skillDescription } from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/attestation-actions");

/** Trusted regression verdicts needed to demote without a local one. */
export const TRUSTED_REGRESSIONS_TO_DEMOTE = 2;

function isRegression(a: SkillAttestation): boolean {
  return a.verdict === "regression" || a.regressions > 0;
}

/** Regression attestations that count: fresh, current corpus generation, newest per attester. */
export function actionableRegressions(
  atts: SkillAttestation[],
  now: number,
  corpusPrefix: string = currentAttestationCorpusPrefix(),
): SkillAttestation[] {
  const newest = new Map<string, SkillAttestation>();
  for (const a of atts) {
    if (now - a.attested_at > ATTESTATION_MAX_AGE_MS || a.attested_at > now + 5 * 60 * 1000) {
      continue;
    }
    if (!a.corpus_version.startsWith(corpusPrefix)) {
      continue;
    }
    const prev = newest.get(a.attester_pubkey);
    if (!prev || prev.attested_at < a.attested_at) {
      newest.set(a.attester_pubkey, a);
    }
  }
  // The attester's NEWEST verdict decides; an old regression superseded by
  // an accepted re-score is not a regression.
  return [...newest.values()].filter(isRegression);
}

export interface DemotionDecision {
  demote: boolean;
  ownRegression: boolean;
  trustedRegressions: number;
  reason: string;
}

export function decideAttestationDemotion(params: {
  attestations: SkillAttestation[];
  weightOf: (attesterPubkey: string) => number;
  ownAttesterPubkey: string;
  now: number;
  corpusPrefix?: string;
}): DemotionDecision {
  const regressions = actionableRegressions(params.attestations, params.now, params.corpusPrefix);
  const ownRegression = regressions.some((a) => a.attester_pubkey === params.ownAttesterPubkey);
  const trustedRegressions = regressions.filter(
    (a) =>
      a.attester_pubkey !== params.ownAttesterPubkey && params.weightOf(a.attester_pubkey) >= 1,
  ).length;
  const demote = ownRegression || trustedRegressions >= TRUSTED_REGRESSIONS_TO_DEMOTE;
  return {
    demote,
    ownRegression,
    trustedRegressions,
    reason: ownRegression
      ? `local re-score found a regression`
      : `${trustedRegressions} trusted regression attestation(s)`,
  };
}

export interface AttestationDemotionResult {
  examined: number;
  demoted: string[];
}

/**
 * Walk every live PEER skill (a `.provenance.json` beside SKILL.md), look
 * up the attestations for its current bytes, and canary-off the ones the
 * rule demotes. Idempotent: a skill already canary-off is left alone.
 */
export async function applyAttestationDemotions(params: {
  db: DatabaseSync;
  weightOf: (attesterPubkey: string) => number;
  ownAttesterPubkey: string;
  storeOpts?: ImpactTrailOptions;
  now?: number;
}): Promise<AttestationDemotionResult> {
  const opts = params.storeOpts ?? {};
  const trailOpts = opts.configDir ? { configDir: opts.configDir } : {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const now = params.now ?? Date.now();
  const registry = await readCanaryRegistry(trailOpts);
  let names: string[];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return { examined: 0, demoted: [] };
  }
  const result: AttestationDemotionResult = { examined: 0, demoted: [] };
  for (const name of names) {
    const dir = path.join(roots.liveRoot, name);
    let content: string;
    try {
      await fs.access(path.join(dir, ".provenance.json"));
      content = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
    } catch {
      continue; // not a peer skill, or no body
    }
    result.examined += 1;
    if (isCanaryOff(registry.skills[name])) {
      continue;
    }
    const sha = skillContentSha256(content);
    const decision = decideAttestationDemotion({
      attestations: listAttestations(params.db, sha),
      weightOf: params.weightOf,
      ownAttesterPubkey: params.ownAttesterPubkey,
      now,
    });
    if (!decision.demote) {
      continue;
    }
    await canaryOff(
      name,
      {
        reason: decision.ownRegression ? "regression" : "attestation",
        descriptionAtStart: skillDescription(content) ?? "",
        now,
      },
      trailOpts,
    );
    await appendImpactEntry(
      {
        source: "evolution",
        action: "canary-off",
        skillName: name,
        verdict: "rolled-back",
        detail: `peer skill withheld from every run: ${decision.reason} (sha ${sha.slice(0, 12)})`,
        contentHash: sha,
        stats: {
          trustedRegressions: decision.trustedRegressions,
          ownRegression: decision.ownRegression ? 1 : 0,
        },
        timestamp: now,
      },
      trailOpts,
    );
    result.demoted.push(name);
    log.info(`canary-off ${name}: ${decision.reason}`);
  }
  return result;
}
