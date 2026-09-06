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

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EvolutionMeta } from "./validation-gate.js";
import {
  appendImpactEntry,
  type ImpactTrailOptions,
  resolveWikiDir,
} from "../../agents/skills/impact-trail.js";
import {
  readLive,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { atomicWriteJson } from "./fs-atomic.js";
import {
  buildProvenanceTrailer,
  buildRetractionStub,
  type EvolutionRetractionRecord,
} from "./provenance-trailer.js";

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
): Promise<EvolutionMeta | null> {
  try {
    const raw = await fs.readFile(path.join(roots.liveRoot, name, ".evolution-meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as EvolutionMeta;
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
    // PLAN-45 Phase 3: only a skill that survived its canary window (ladder
    // `stable`) leaves the node. A canary, a rolled-back or a retired
    // version never propagates; a legacy record without a ladder keeps the
    // maturity-days rule below.
    if (meta.ladder && meta.ladder.state !== "stable") {
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

const PRIVATE_IDENTIFIER_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//, what: "a home-directory path" },
  { re: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/, what: "a Windows user-profile path" },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, what: "an email address" },
  { re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, what: "an IP address" },
];

/** Why the body must not leave this node, or null when it is clean. */
export function findPublishLeak(body: string): string | null {
  if (redactSensitiveText(body, { mode: "tools" }) !== body) {
    return "body contains a secret the redactor would strip";
  }
  for (const { re, what } of PRIVATE_IDENTIFIER_PATTERNS) {
    if (re.test(body)) {
      return `body contains ${what}`;
    }
  }
  return null;
}

const provenanceTrailer = buildProvenanceTrailer;

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
      // B7: a propagated SKILL.md must carry no secrets and no user-specific
      // identifiers. Redaction is a REFUSAL, not a rewrite: a body the
      // redactor would change is held with the reason, never published
      // altered (the receiver verifies the hash of what we sign).
      const leak = findPublishLeak(content);
      if (leak) {
        result.failed.push({ name: skill.name, detail: `refusing to publish: ${leak}` });
        continue;
      }
      const withProvenance = `${content.replace(/\n+$/, "")}\n${provenanceTrailer(skill.meta)}`;
      const raw = await deps.publisher.publishSkill(
        Buffer.from(withProvenance, "utf-8").toString("base64"),
        skill.name,
      );
      const metaPath = path.join(roots.liveRoot, skill.name, ".evolution-meta.json");
      // PLAN-45 Phase 3.4: keep the WIRE hash (body + trailer, what the
      // orchestrator signed) so a later retraction can name exactly what
      // was broadcast. The orchestrator reports the hash it put on the
      // envelope; that one wins over the local computation when they differ.
      const localHash = wireContentHash(withProvenance);
      const reported = (raw as { content_hash?: unknown } | null | undefined)?.content_hash;
      const contentHash =
        typeof reported === "string" && /^[0-9a-f]{64}$/.test(reported) ? reported : localHash;
      if (contentHash !== localHash) {
        log.warn(
          `publish hash mismatch for ${skill.name}: orchestrator ${contentHash.slice(0, 12)} vs local ${localHash.slice(0, 12)}; recording the orchestrator's`,
        );
      }
      const nextMeta: EvolutionMeta = {
        ...skill.meta,
        published: { at: deps.now ?? Date.now(), contentHash },
      };
      await atomicWriteJson(metaPath, nextMeta);
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

/** SHA-256 of the exact bytes handed to the publisher (the envelope's content_hash). */
export function wireContentHash(skillMd: string): string {
  return createHash("sha256").update(Buffer.from(skillMd, "utf-8")).digest("hex");
}

export const RETRACTIONS_FILENAME = "retractions.jsonl";

export function retractionsPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), RETRACTIONS_FILENAME);
}

/**
 * PLAN-45 Phase 3.4: broadcast a signed retraction for a version this node
 * published. The stub rides the existing publish verb (the orchestrator
 * signs it with the same key), so a receiver can bind it to the original
 * envelope by author pubkey + content hash without any orchestrator change.
 * Idempotent per content hash via the local retractions ledger.
 */
export async function publishRetraction(deps: {
  publisher: SkillPublisher | null;
  name: string;
  contentHash: string;
  reason: string;
  storeOpts?: ImpactTrailOptions;
  now?: number;
}): Promise<{ published: boolean; detail: string }> {
  const trailOpts = deps.storeOpts?.configDir ? { configDir: deps.storeOpts.configDir } : {};
  const now = deps.now ?? Date.now();
  const record: EvolutionRetractionRecord = {
    origin: "wiki-evolution",
    name: deps.name,
    contentSha256: deps.contentHash,
    reason: deps.reason.slice(0, 300),
    retractedAt: new Date(now).toISOString(),
  };
  const file = retractionsPath(trailOpts);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Once per hash (adversarial 3-8): a second demotion of the same bytes
  // (crash replay, pre-manifest rollback loop) must not re-broadcast.
  try {
    const prior = (await fs.readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as {
            direction?: string;
            contentSha256?: string;
            publishedToMesh?: boolean;
          };
        } catch {
          return null;
        }
      });
    if (
      prior.some(
        (r) => r?.direction === "own" && r.contentSha256 === deps.contentHash && r.publishedToMesh,
      )
    ) {
      return {
        published: false,
        detail: `retraction for ${deps.contentHash.slice(0, 12)} already published`,
      };
    }
  } catch {
    // no ledger yet
  }
  await fs.appendFile(
    file,
    `${JSON.stringify({ ...record, direction: "own", publishedToMesh: Boolean(deps.publisher) })}\n`,
    "utf-8",
  );
  if (!deps.publisher) {
    return { published: false, detail: "no publisher; retraction recorded locally" };
  }
  try {
    await deps.publisher.publishSkill(
      Buffer.from(buildRetractionStub(record), "utf-8").toString("base64"),
      deps.name,
    );
  } catch (err) {
    return { published: false, detail: `retraction publish failed: ${String(err)}` };
  }
  await appendImpactEntry(
    {
      source: "evolution",
      action: "p2p-retract",
      skillName: deps.name,
      verdict: "rolled-back",
      detail: `retraction published for ${deps.contentHash.slice(0, 12)}: ${record.reason}`,
      contentHash: deps.contentHash,
    },
    trailOpts,
  );
  return { published: true, detail: `retraction published for ${deps.contentHash.slice(0, 12)}` };
}
