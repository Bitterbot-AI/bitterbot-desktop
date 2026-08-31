/**
 * PLAN-42 Phase 5: P2P propagation of validated evolved skills — the
 * flywheel's outbound leg (D-E reversal: contributing high-quality skills
 * to the network is the point of the system).
 *
 * Quality doctrine, enforced here:
 *   1. NOTHING propagates that has not passed the validation gate
 *      (.evolution-meta.json validation.verdict === "accepted").
 *   2. Maturity: a validated skill must survive on the node for
 *      `maturityDays` (default 3) before publishing — time for the
 *      slow-update/rollback machinery and the operator to catch a
 *      regression the gate missed.
 *   3. Evidence ships WITH the skill: the published SKILL.md carries a
 *      machine-readable provenance trailer (HTML comment) with the
 *      validation verdict, scores, corpus version and model tag, so
 *      receiving nodes can see the claim — and re-gate it locally instead
 *      of trusting it (receivers already quarantine + injection-scan every
 *      P2P skill; local re-validation of ingested skills is the receiving
 *      half, tracked post-orchestrator-0.2.3).
 *   4. Publish-once: a published marker lands in .evolution-meta.json; a
 *      re-validated new version may publish again.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EvolutionMeta } from "./validation-gate.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import {
  readLive,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skill-evolution/p2p-publish");

export const DEFAULT_MATURITY_DAYS = 3;

/** Minimal publish surface of the orchestrator bridge (test-fakeable). */
export interface SkillPublisher {
  publishSkill(skillMdBase64: string, name: string): Promise<unknown>;
}

export interface EligibleEvolvedSkill {
  name: string;
  validatedAt: number;
  meta: EvolutionMeta;
}

async function readLiveEvolutionMeta(
  roots: StorageRoots,
  name: string,
): Promise<(EvolutionMeta & { published?: { at: number } }) | null> {
  try {
    const raw = await fs.readFile(path.join(roots.liveRoot, name, ".evolution-meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as EvolutionMeta & { published?: { at: number } };
    return parsed.origin === "wiki-evolution" ? parsed : null;
  } catch {
    return null;
  }
}

/** Live evolved skills that satisfy the propagation doctrine right now. */
export async function listP2pEligibleEvolvedSkills(
  opts: ImpactTrailOptions & { maturityDays?: number; now?: number } = {},
): Promise<EligibleEvolvedSkill[]> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const maturityMs = (opts.maturityDays ?? DEFAULT_MATURITY_DAYS) * 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.readdir(roots.liveRoot);
  } catch {
    return [];
  }
  const out: EligibleEvolvedSkill[] = [];
  for (const name of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      continue;
    }
    const meta = await readLiveEvolutionMeta(roots, name);
    if (!meta || meta.validation?.verdict !== "accepted") {
      continue;
    }
    const validatedAt = meta.validation.validatedAt;
    if (!Number.isFinite(validatedAt) || now - validatedAt < maturityMs) {
      continue;
    }
    // Publish-once per validated version.
    if (meta.published && meta.published.at >= validatedAt) {
      continue;
    }
    out.push({ name, validatedAt, meta });
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

function provenanceTrailer(meta: EvolutionMeta): string {
  const v = meta.validation;
  const record = {
    origin: "wiki-evolution",
    verdict: v?.verdict,
    mode: v?.mode,
    ...(typeof v?.meanDelta === "number" ? { meanDelta: v.meanDelta } : {}),
    ...(typeof v?.ci95Low === "number" ? { ci95Low: v.ci95Low } : {}),
    ...(typeof v?.trials === "number" ? { trials: v.trials } : {}),
    ...(v?.corpusVersion ? { corpusVersion: v.corpusVersion } : {}),
    ...(v?.model ? { model: v.model } : {}),
    validatedAt: v?.validatedAt,
    notice:
      "Receiving nodes should re-validate locally; this is the sender's evidence, not a guarantee.",
  };
  return `\n<!-- wiki-evolution-provenance ${JSON.stringify(record)} -->\n`;
}

export interface PublishSweepResult {
  published: string[];
  failed: Array<{ name: string; detail: string }>;
  eligible: number;
}

/**
 * Publish every eligible evolved skill through the orchestrator bridge.
 * Failures are per-skill and non-fatal; the published marker is written
 * ONLY after the bridge accepted the envelope.
 */
export async function publishEligibleEvolvedSkills(deps: {
  publisher: SkillPublisher | null;
  storeOpts?: ImpactTrailOptions;
  maturityDays?: number;
  now?: number;
}): Promise<PublishSweepResult> {
  const storeOpts = deps.storeOpts ?? {};
  const trailOpts = storeOpts.configDir ? { configDir: storeOpts.configDir } : {};
  const eligible = await listP2pEligibleEvolvedSkills({
    ...trailOpts,
    ...(deps.maturityDays !== undefined ? { maturityDays: deps.maturityDays } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const result: PublishSweepResult = { published: [], failed: [], eligible: eligible.length };
  if (!deps.publisher || eligible.length === 0) {
    return result;
  }
  const roots = resolveStorageRoots(storeOpts.configDir ? { configDir: storeOpts.configDir } : {});
  for (const skill of eligible) {
    try {
      const content = await readLive(roots, skill.name);
      if (!content) {
        result.failed.push({ name: skill.name, detail: "live SKILL.md vanished" });
        continue;
      }
      const withProvenance = `${content.replace(/\n+$/, "")}\n${provenanceTrailer(skill.meta)}`;
      await deps.publisher.publishSkill(
        Buffer.from(withProvenance, "utf-8").toString("base64"),
        skill.name,
      );
      const metaPath = path.join(roots.liveRoot, skill.name, ".evolution-meta.json");
      const nextMeta = { ...skill.meta, published: { at: deps.now ?? Date.now() } };
      await fs.writeFile(metaPath, JSON.stringify(nextMeta, null, 2), "utf-8");
      await appendImpactEntry(
        {
          source: "evolution",
          action: "p2p-publish",
          skillName: skill.name,
          verdict: "accepted",
          detail: `published to P2P with validation evidence (verdict=${skill.meta.validation?.verdict}, mode=${skill.meta.validation?.mode})`,
        },
        trailOpts,
      );
      result.published.push(skill.name);
      log.info(`published evolved skill to P2P: ${skill.name}`);
    } catch (err) {
      result.failed.push({ name: skill.name, detail: String(err) });
      log.warn(`P2P publish failed for ${skill.name}: ${String(err)}`);
    }
  }
  return result;
}
