/**
 * Zero-Trust Skill Ingestion Pipeline
 *
 * Verifies, validates, and optionally ingests skills arriving via Gossipsub.
 * Policies: "auto" (accept if valid), "review" (quarantine), "deny" (reject all).
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseSkillMarkdown } from "../../memory/skill-curator-judge.js";
import {
  type EvolutionRetractionRecord,
  parseProvenanceTrailer,
  parseRetractionTrailer,
} from "../../memory/skill-evolution/provenance-trailer.js";
import {
  type InjectionScanResult,
  type InjectionSeverity,
  scanSkillForInjection,
  shouldForceQuarantine,
} from "../../security/skill-injection-scanner.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  checkDescriptionContract,
  type DescriptionContractIssue,
  describeContractIssues,
} from "./description-contract.js";
import {
  findDescriptionOverlap,
  type LiveSkillIndexEntry,
  listLiveSkillIndex,
} from "./description-overlap.js";
import { appendImpactEntry, resolveWikiDir } from "./impact-trail.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "./refresh.js";
import { archiveVersion, resolveStorageRoots } from "./skill-storage.js";

const log = createSubsystemLogger("skills/ingest");

/**
 * Atomic write for quarantine artifacts. Gossip re-broadcasts the same skill
 * repeatedly and two deliveries can ingest the same name concurrently; plain
 * writeFile interleaves the two writers and the loser's tail survives past
 * the winner's EOF ("...false\n}se\n}") — 28 of 31 quarantine envelopes on
 * the pilot node were corrupted this way and rendered as "Incomplete
 * download". rename() is atomic, so concurrent writers now leave exactly one
 * intact winner.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Parse an envelope JSON, salvaging legacy files corrupted by the concurrent
 * write bug above: their content is one valid JSON object with garbage
 * appended, so cutting at the first balanced close brace recovers it.
 */
export function parseEnvelopeJson(raw: string): SkillEnvelope | undefined {
  try {
    return JSON.parse(raw) as SkillEnvelope;
  } catch {
    // Salvage: cut at the first top-level balanced brace.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = inString;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(0, i + 1)) as SkillEnvelope;
          } catch {
            return undefined;
          }
        }
      }
    }
    return undefined;
  }
}

export type SkillEnvelope = {
  version: number;
  skill_md: string; // base64
  name: string;
  author_peer_id: string;
  author_pubkey: string; // base64
  signature: string; // base64
  timestamp: number;
  content_hash: string; // sha256 hex
  // Versioning (Phase 6 — optional, backward-compatible)
  stable_skill_id?: string;
  skill_version?: number;
  previous_content_hash?: string;
  tags?: string[];
  category?: string;
  // Management verification (Phase 3)
  management_signature?: string;
  management_pubkey?: string;
  /** Unix ms expiration for auto-generated skills (PLAN-10 Skill Seekers TTL). */
  expires_at?: number;
  /** Free-form provenance metadata (e.g. marketplace_opportunity, source_url). */
  provenance?: Record<string, unknown>;
};

export type IngestResult = {
  ok: boolean;
  /** `retracted`: PLAN-45 Phase 3.4, a signed retraction stub was applied (never stored as a skill). */
  action: "accepted" | "quarantined" | "rejected" | "retracted";
  skillName?: string;
  skillPath?: string;
  reason?: string;
};

type RateState = {
  count: number;
  windowStart: number;
};

const peerRates = new Map<string, RateState>();
const seenHashes = new Set<string>();
const MAX_SEEN_HASHES = 10_000;

export async function ingestSkill(params: {
  envelope: SkillEnvelope;
  config: BitterbotConfig;
  workspaceDir?: string;
  /**
   * Where this skill came from. "peer" (default) is the zero-trust gossip
   * receive path that skills-incoming/ is specced for. "external-scrape" is
   * the node's OWN research output (skill-seekers harvesting a GitHub repo) —
   * a local artifact, NOT a peer skill, so it is accepted directly rather than
   * laundered through the peer quarantine under a synthetic peer id. The origin
   * is also recorded so the review UI can label local vs peer content honestly.
   */
  origin?: "peer" | "external-scrape";
  /**
   * Our own skill-publish pubkey. When set, a "peer" skill whose author_pubkey
   * matches it is dropped as self-loopback (a crystal we broadcast came back to
   * us over gossip) instead of being quarantined as if a stranger sent it.
   */
  ownPublishPubkey?: string;
  reputationManager?: {
    getTrustLevel(pubkey: string): string;
    recordSkillReceived(pubkey: string, peerId: string): void;
    recordIngestionResult(pubkey: string, accepted: boolean): void;
    recordInjectionFlag?(pubkey: string, severity: InjectionSeverity): void;
  };
  /** Override system-event sink for tests; production uses the real queue. */
  notifyQuarantine?: (message: string) => void;
}): Promise<IngestResult> {
  const { envelope, config, workspaceDir } = params;
  const origin = params.origin ?? "peer";
  // PLAN-45 Phase 0: "external-scrape" (Skill Seekers harvest) used to count
  // as local origin and accept straight into skills/, bypassing the review
  // policy, the routing hold and the synthetic peer's trust level, while the
  // adapter's docs promised quarantine. Scraped content is untrusted input
  // like any peer skill: the origin is kept as a provenance label only.
  const p2pConfig = config.skills?.p2p;
  const policy = p2pConfig?.ingestPolicy ?? "review";

  // Self-loopback guard: a crystal this node published can be delivered back to
  // it over gossip. Dropping it here stops the node from quarantining its own
  // output as an anonymous inbound peer skill (a source of the "received from
  // unknown peer" clutter).
  if (params.ownPublishPubkey && envelope.author_pubkey === params.ownPublishPubkey) {
    return { ok: false, action: "rejected", reason: "self-loopback (own published skill)" };
  }

  // Policy: deny all (peer skills and scraped harvests alike).
  if (policy === "deny") {
    return { ok: false, action: "rejected", reason: "ingestion policy is deny" };
  }

  // 1. Verify Ed25519 signature
  if (!verifySignature(envelope)) {
    log.warn(`Rejected skill from ${envelope.author_peer_id}: invalid signature`);
    return { ok: false, action: "rejected", reason: "invalid Ed25519 signature" };
  }

  // 2. Verify content hash
  const skillBytes = Buffer.from(envelope.skill_md, "base64");
  const computedHash = createHash("sha256").update(skillBytes).digest("hex");
  if (computedHash !== envelope.content_hash) {
    log.warn(`Rejected skill from ${envelope.author_peer_id}: content hash mismatch`);
    return { ok: false, action: "rejected", reason: "content hash mismatch" };
  }

  // 2b. PLAN-45 Phase 3.4: bytes the author retracted stay retracted (a
  // fresh envelope has a fresh timestamp/signature, the same hash).
  if (await isRetracted(envelope.author_pubkey, envelope.content_hash)) {
    return { ok: false, action: "rejected", reason: "retracted by its author" };
  }

  // 3. Content-hash dedup
  if (seenHashes.has(envelope.content_hash)) {
    return { ok: false, action: "rejected", reason: "duplicate content hash" };
  }

  // 3b. PLAN-42 quality doctrine: unvalidated machine-generated crystals from
  // the legacy auto-publish pipeline (UUID-named "Dream-generated skill
  // crystal" envelopes) are rejected at the door instead of cluttering the
  // review queue — 28 of them sat in this node's quarantine as junk. A
  // wiki-evolution provenance trailer marks a skill that passed a validation
  // gate somewhere; those still quarantine for local review. Kill switch:
  // skills.p2p.rejectLegacyCrystals=false restores the old behavior.
  if (p2pConfig?.rejectLegacyCrystals !== false) {
    const md = Buffer.from(envelope.skill_md, "base64").toString("utf-8");
    const looksLikeLegacyCrystal =
      /^description:\s*Dream-generated skill crystal\s*$/m.test(md) || /\bcrystal_id:/.test(md);
    // PLAN-45 Phase 0: evidence means a PARSED trailer with an accepted
    // verdict, not the marker text (a bare substring exempted anything).
    const hasValidationEvidence = parseProvenanceTrailer(md) !== null;
    if (looksLikeLegacyCrystal && !hasValidationEvidence) {
      log.info(
        `Rejected legacy unvalidated dream crystal "${envelope.name}" from ${envelope.author_peer_id}`,
      );
      params.reputationManager?.recordIngestionResult(envelope.author_pubkey, false);
      return { ok: false, action: "rejected", reason: "legacy unvalidated dream crystal" };
    }
  }

  // 3c. PLAN-45 Phase 3.4: a signed RETRACTION rides the same verb. It is
  // bound to the original by author pubkey + content hash (the signature
  // covers the stub, and only the original key's copies match), never
  // stored as a skill, and remembered so a republish of the same bytes by
  // the same key is refused. It runs BEFORE the rate limit (adversarial
  // 3-9): the one message that must land after a publish burst.
  const skillContent = skillBytes.toString("utf-8");
  const retraction = parseRetractionTrailer(skillContent);
  if (retraction) {
    if (seenHashes.size >= MAX_SEEN_HASHES) {
      seenHashes.clear();
    }
    seenHashes.add(envelope.content_hash);
    if (await isRetracted(envelope.author_pubkey, retraction.contentSha256)) {
      return {
        ok: true,
        action: "retracted",
        skillName: normalizeSkillName(retraction.name),
        reason: "already applied",
      };
    }
    return applyPeerRetraction({ envelope, retraction, config });
  }

  // 4. Rate limiting
  const maxPerHour = p2pConfig?.maxIngestedPerHour ?? 20;
  if (!checkRateLimit(envelope.author_peer_id, maxPerHour)) {
    return { ok: false, action: "rejected", reason: "rate limit exceeded" };
  }

  // 5. Parse and validate SKILL.md
  if (!validateSkillContent(skillContent)) {
    return { ok: false, action: "rejected", reason: "invalid SKILL.md structure" };
  }
  // Sender's validation claim, parsed once and carried on the envelope for
  // the review list and the receiver re-gate (PLAN-45 Phase 4). Null when
  // absent or malformed; never a reason to skip local review.
  const evolutionProvenance = parseProvenanceTrailer(skillContent);

  // 5b. Injection scan (PLAN-13 Phase A).
  // Runs on the decoded bytes to catch adversarial content from a signed-but-
  // malicious peer. A `critical` severity force-quarantines regardless of the
  // configured policy or the publisher's trust level, on the grounds that we
  // cannot solve content-layer attacks at the transport layer.
  const scannerMode = p2pConfig?.injectionScanner ?? "regex";
  const scanResult: InjectionScanResult | null =
    scannerMode === "off" ? null : scanSkillForInjection(skillContent);
  const forceQuarantine = scanResult ? shouldForceQuarantine(scanResult.severity) : false;
  if (scanResult && scanResult.severity !== "ok") {
    log.warn(
      `Skill from ${envelope.author_peer_id} flagged by injection scan: ${scanResult.reason}`,
    );
    params.reputationManager?.recordInjectionFlag?.(envelope.author_pubkey, scanResult.severity);
  }

  // 6. Check existing skills for content-hash dedup
  const existingSkillsDir = path.join(CONFIG_DIR, "skills");
  if (await skillExistsWithHash(existingSkillsDir, envelope.content_hash)) {
    return { ok: false, action: "rejected", reason: "skill already exists" };
  }

  // Record this hash (cap at MAX_SEEN_HASHES to prevent unbounded growth)
  if (seenHashes.size >= MAX_SEEN_HASHES) {
    seenHashes.clear();
  }
  seenHashes.add(envelope.content_hash);

  // 7. Check trust: supports both legacy trustList and graduated reputation (Phase 4)
  const trustList = p2pConfig?.trustList ?? [];
  const isTrusted = trustList.includes(envelope.author_pubkey);

  // Graduated trust: check for PeerReputationManager via optional reputationManager param
  // If available, use trust level; otherwise fall back to binary trust list
  const trustLevel = params.reputationManager
    ? params.reputationManager.getTrustLevel(envelope.author_pubkey)
    : isTrusted
      ? "verified"
      : "untrusted";

  const isAutoAccepted = trustLevel === "trusted" || trustLevel === "verified";

  // Record in reputation system if available
  params.reputationManager?.recordSkillReceived(envelope.author_pubkey, envelope.author_peer_id);

  // 7b. PLAN-44 Phase 5b: the description contract and the overlap check
  // at ingest, AFTER dedupe and existence (a rejected skill pays nothing).
  // The receiving agent finds a skill ONLY through its description in the
  // runtime index, and opens one only when exactly one description
  // applies. A peer skill whose description cannot route, or collides with
  // a local skill's, is held for review with the reason on the envelope.
  const routing = await assessRouting(envelope.name, skillContent);
  const routingHold = routing.contractIssues.length > 0 || routing.overlap !== null;
  if (routing.contractIssues.length > 0 || routing.overlap) {
    log.warn(
      `Skill ${normalizeSkillName(envelope.name)} (${envelope.author_peer_id}): ${describeRouting(routing)}${routingHold ? "; held for review" : ""}`,
    );
  }

  // 8. Determine destination based on origin, policy, trust level, and scan.
  // `forceQuarantine` overrides accept when the scanner returns critical — the
  // injection scan still guards even our own scraped content. A skill is
  // accepted directly when it is local-origin (our own research) OR a trusted
  // peer under `auto` policy; everything else is held for review.
  const acceptDirectly = !forceQuarantine && !routingHold && policy === "auto" && isAutoAccepted;
  if (acceptDirectly) {
    // Accept directly into skills directory
    const skillName = normalizeSkillName(envelope.name);
    const skillDir = path.join(CONFIG_DIR, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillPath, skillContent, "utf-8");

    // Write provenance metadata
    const metaPath = path.join(skillDir, ".provenance.json");
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          origin,
          author_peer_id: envelope.author_peer_id,
          author_pubkey: envelope.author_pubkey,
          signature: envelope.signature,
          content_hash: envelope.content_hash,
          timestamp: envelope.timestamp,
          ingested_at: Date.now(),
          expires_at: envelope.expires_at,
          provenance: envelope.provenance,
          injection_scan: scanResult ?? undefined,
          routing,
          evolution_provenance: evolutionProvenance ?? undefined,
        },
        null,
        2,
      ),
      "utf-8",
    );

    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "manual",
      changedPath: skillPath,
    });

    log.info(`Accepted skill (${origin}): ${skillName} from ${envelope.author_peer_id}`);
    params.reputationManager?.recordIngestionResult(envelope.author_pubkey, true);
    return { ok: true, action: "accepted", skillName, skillPath };
  }

  // Quarantine: write to skills-incoming directory.
  // We land here for any of: review/deny policy, untrusted publisher under auto,
  // or `forceQuarantine === true` because the injection scan flagged critical.
  const quarantineDir = p2pConfig?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const skillName = normalizeSkillName(envelope.name);
  const incomingDir = path.join(quarantineDir, skillName);
  await fs.mkdir(incomingDir, { recursive: true });

  // Write the envelope BEFORE the SKILL.md: the review list keys a skill's
  // origin/peer off the envelope, so if the process is killed mid-write an
  // envelope-first order can never leave a SKILL.md with no envelope (which the
  // UI would render as "received from unknown peer"). An envelope with no
  // SKILL.md yet is a recognizably-incomplete entry, not a phantom peer.
  const envelopePath = path.join(incomingDir, ".envelope.json");
  await atomicWriteFile(
    envelopePath,
    JSON.stringify(
      {
        ...envelope,
        origin,
        injection_scan: scanResult ?? undefined,
        force_quarantined: forceQuarantine,
        routing,
        routing_hold: routingHold,
        evolution_provenance: evolutionProvenance ?? undefined,
      },
      null,
      2,
    ),
  );
  const skillPath = path.join(incomingDir, "SKILL.md");
  await atomicWriteFile(skillPath, skillContent);

  // Reputation: a force-quarantine on a previously-trusted peer is the loud
  // signal we want to feed back into trust. Counts as a rejected ingestion.
  if (forceQuarantine) {
    params.reputationManager?.recordIngestionResult(envelope.author_pubkey, false);
  }

  // Notify the operator. Quarantined skills are invisible without this.
  const reason = forceQuarantine
    ? `injection scan ${scanResult?.severity} (${scanResult?.flags.join(", ") ?? "none"})`
    : scanResult?.severity === "medium" || scanResult?.severity === "low"
      ? `injection scan ${scanResult.severity}; trust=${trustLevel}`
      : `trust=${trustLevel}`;
  const notification =
    `Skill "${skillName}" from peer ${envelope.author_peer_id} held in quarantine ` +
    `(${reason}). Run "skills.incoming.list" to review.`;
  if (params.notifyQuarantine) {
    try {
      params.notifyQuarantine(notification);
    } catch {
      // Best-effort
    }
  } else {
    await emitQuarantineSystemEvent(notification);
  }

  log.info(`Quarantined skill: ${skillName} from ${envelope.author_peer_id} (${reason})`);
  return { ok: true, action: "quarantined", skillName, skillPath };
}

/**
 * Best-effort dispatch of a quarantine notification onto the main session's
 * system-event queue. We resolve the dependencies dynamically because the
 * reputation/system-events surface is gateway-runtime; tests typically pass
 * `notifyQuarantine` directly to skip this path.
 */
async function emitQuarantineSystemEvent(message: string): Promise<void> {
  try {
    const [{ enqueueSystemEvent }, { resolveMainSessionKeyFromConfig }] = await Promise.all([
      import("../../infra/system-events.js"),
      import("../../config/sessions.js"),
    ]);
    const sessionKey = resolveMainSessionKeyFromConfig();
    if (!sessionKey) return;
    enqueueSystemEvent(message, { sessionKey });
  } catch (err) {
    log.debug(`quarantine notification skipped: ${String(err)}`);
  }
}

/**
 * Read the author pubkey from a quarantined skill's envelope so a manual
 * accept/reject can feed graduated trust. Best-effort; returns null on any
 * read/parse failure.
 */
async function readQuarantineContentHash(incomingDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(incomingDir, ".envelope.json"), "utf-8");
    const parsed = parseEnvelopeJson(raw) as { content_hash?: unknown } | undefined;
    return typeof parsed?.content_hash === "string" ? parsed.content_hash : null;
  } catch {
    return null;
  }
}

async function readQuarantineAuthorPubkey(incomingDir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(incomingDir, ".envelope.json"), "utf-8");
    const parsed = parseEnvelopeJson(raw) as { author_pubkey?: unknown } | undefined;
    return typeof parsed?.author_pubkey === "string" ? parsed.author_pubkey : null;
  } catch {
    return null;
  }
}

/**
 * PLAN-44 Phase 3: only an ACCEPTED envelope becomes a memory chunk in the
 * skill-network bridge. Quarantined ones wait for the operator's accept
 * (skills.incoming.accept re-routes them through `readAcceptedEnvelope`).
 */
export function shouldBridgeIngest(
  result: Pick<IngestResult, "action"> | null | undefined,
): boolean {
  return result?.action === "accepted";
}

/** The envelope an accept carried into the live dir as `.provenance.json`, if any. */
export async function readAcceptedEnvelope(skillPath: string): Promise<SkillEnvelope | null> {
  try {
    const raw = await fs.readFile(path.join(path.dirname(skillPath), ".provenance.json"), "utf-8");
    const parsed = JSON.parse(raw) as SkillEnvelope;
    return parsed && typeof parsed.content_hash === "string" && typeof parsed.skill_md === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function acceptIncomingSkill(params: {
  skillName: string;
  config: BitterbotConfig;
  workspaceDir?: string;
  /** Live reputation manager so a manual accept credits the peer (F6). */
  reputationManager?: { recordIngestionResult(peerPubkey: string, accepted: boolean): void };
}): Promise<IngestResult> {
  const { skillName, config, workspaceDir, reputationManager } = params;
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const incomingDir = path.join(quarantineDir, skillName);
  const skillPath = path.join(incomingDir, "SKILL.md");

  try {
    const content = await fs.readFile(skillPath, "utf-8");
    // Read the author pubkey BEFORE we delete the quarantine dir.
    const authorPubkey = await readQuarantineAuthorPubkey(incomingDir);
    // PLAN-44 Phase 3 (adversarial L7): the file sat in a writable review
    // dir; what gets accepted (and becomes a memory chunk under the
    // envelope's hash) must still be what the peer signed.
    const envelopeHash = await readQuarantineContentHash(incomingDir);
    if (envelopeHash) {
      const onDisk = createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
      if (onDisk !== envelopeHash) {
        return {
          ok: false,
          action: "rejected",
          reason:
            "quarantined SKILL.md no longer matches its envelope content hash; reject it and ask the peer to republish",
        };
      }
    }
    const targetDir = path.join(CONFIG_DIR, "skills", skillName);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "SKILL.md"), content, "utf-8");

    // Copy provenance if exists. An operator accept overrides a routing
    // hold; say so on the live record instead of carrying `routing_hold`
    // forever (adversarial L10).
    try {
      const envelope = await fs.readFile(path.join(incomingDir, ".envelope.json"), "utf-8");
      let provenance = envelope;
      try {
        const parsed = JSON.parse(envelope) as Record<string, unknown>;
        if (parsed.routing_hold === true) {
          provenance = JSON.stringify(
            {
              ...parsed,
              routing_hold: false,
              routing_hold_overridden_by: "operator",
              accepted_at: Date.now(),
            },
            null,
            2,
          );
        }
      } catch {
        // keep verbatim
      }
      await fs.writeFile(path.join(targetDir, ".provenance.json"), provenance, "utf-8");
    } catch {}

    // Remove from quarantine
    await fs.rm(incomingDir, { recursive: true, force: true });

    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "manual",
      changedPath: path.join(targetDir, "SKILL.md"),
    });

    // Credit the peer so graduated trust can eventually auto-accept them.
    // Without this the manual-review flow was a trust dead end: every peer
    // skill went to quarantine, an accept recorded nothing, skills_accepted
    // stayed 0 forever, and no peer could ever leave review (audit F6).
    if (authorPubkey && reputationManager) {
      reputationManager.recordIngestionResult(authorPubkey, true);
    }

    log.info(`Accepted incoming skill: ${skillName}`);
    return { ok: true, action: "accepted", skillName, skillPath: path.join(targetDir, "SKILL.md") };
  } catch (err) {
    return { ok: false, action: "rejected", reason: String(err) };
  }
}

export async function rejectIncomingSkill(params: {
  skillName: string;
  config: BitterbotConfig;
  /** Live reputation manager so a manual reject debits the peer (F6). */
  reputationManager?: { recordIngestionResult(peerPubkey: string, accepted: boolean): void };
}): Promise<IngestResult> {
  const { skillName, config, reputationManager } = params;
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const incomingDir = path.join(quarantineDir, skillName);

  try {
    const authorPubkey = await readQuarantineAuthorPubkey(incomingDir);
    await fs.rm(incomingDir, { recursive: true, force: true });
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: incomingDir });
    if (authorPubkey && reputationManager) {
      reputationManager.recordIngestionResult(authorPubkey, false);
    }
    log.info(`Rejected incoming skill: ${skillName}`);
    return { ok: true, action: "rejected", skillName };
  } catch (err) {
    return { ok: false, action: "rejected", reason: String(err) };
  }
}

/**
 * PLAN-13 Phase C: bulk-reject every quarantined skill from a single peer.
 *
 * The natural use case: an operator just learned a peer is compromised
 * and wants to drop everything that peer has staged for review without
 * clicking through each entry. Built on top of `rejectIncomingSkill` so
 * the per-skill behavior (and any future quarantine cleanup hooks) stays
 * single-sourced.
 *
 * The match is on `author_peer_id` from each envelope.json. If a skill
 * in quarantine has no envelope (corruption, partial write), it is left
 * in place — the operator can deal with it manually.
 */
export async function rejectIncomingSkillsByPeer(params: {
  authorPeerId: string;
  config: BitterbotConfig;
}): Promise<{
  ok: boolean;
  rejected: string[];
  errored: Array<{ name: string; reason: string }>;
}> {
  const { authorPeerId, config } = params;
  const incoming = await listIncomingSkills(config);
  const matches = incoming.filter((s) => s.author_peer_id === authorPeerId);

  const rejected: string[] = [];
  const errored: Array<{ name: string; reason: string }> = [];

  for (const match of matches) {
    try {
      const result = await rejectIncomingSkill({ skillName: match.name, config });
      if (result.ok) {
        rejected.push(match.name);
      } else {
        errored.push({ name: match.name, reason: result.reason ?? "rejection failed" });
      }
    } catch (err) {
      errored.push({ name: match.name, reason: String(err) });
    }
  }

  log.info(
    `Bulk-rejected ${rejected.length} skill(s) from peer ${authorPeerId}` +
      (errored.length > 0 ? ` (${errored.length} errored)` : ""),
  );

  return { ok: errored.length === 0, rejected, errored };
}

/**
 * Where an item in the review queue actually came from. The UI must not label
 * local content as "received from a peer":
 *  - "peer"           genuine inbound skill from another node (foreign pubkey)
 *  - "external-scrape" this node's own harvest (skill-seekers / agentskills.io)
 *  - "local-dream"     this node's own dream-engine crystal that looped back
 *  - "incomplete"      an envelope-less / unparseable dir (interrupted write)
 */
export type IncomingSkillOrigin = "peer" | "external-scrape" | "local-dream" | "incomplete";

/** PLAN-44 Phase 5b: why a skill would or would not route on this node. */
export interface RoutingAssessment {
  contractIssues: DescriptionContractIssue[];
  overlap: { name: string; tokens: number; containment: number; bigrams: number } | null;
}

export function describeRouting(r: RoutingAssessment): string {
  const parts: string[] = [];
  if (r.contractIssues.length > 0) {
    parts.push(`description contract: ${describeContractIssues(r.contractIssues)}`);
  }
  if (r.overlap) {
    parts.push(
      `description overlaps local skill "${r.overlap.name}" (containment ${r.overlap.containment.toFixed(2)})`,
    );
  }
  return parts.join("; ");
}

/**
 * The local live index, memoized on the skills snapshot version so a gossip
 * burst does not re-read every SKILL.md per envelope (adversarial M5).
 */
let liveIndexCache: { version: number; index: LiveSkillIndexEntry[] } | null = null;
async function cachedLiveSkillIndex(): Promise<LiveSkillIndexEntry[]> {
  const version = getSkillsSnapshotVersion();
  if (liveIndexCache && liveIndexCache.version === version) {
    return liveIndexCache.index;
  }
  const index = await listLiveSkillIndex(resolveStorageRoots());
  liveIndexCache = { version, index };
  return index;
}

/** Description-only contract (the harvest path writes owner/repo names by design) plus overlap against local routable skills. */
async function assessRouting(envelopeName: string, skillMd: string): Promise<RoutingAssessment> {
  const skillName = normalizeSkillName(envelopeName);
  const fm = (parseSkillMarkdown(skillMd)?.frontmatter ?? {}) as Record<string, unknown>;
  const fmName = typeof fm.name === "string" ? fm.name : undefined;
  const description = typeof fm.description === "string" ? fm.description : "";
  const contractIssues = checkDescriptionContract({
    skillName,
    frontmatterName: fmName,
    description,
    liveFrontmatterName: fmName ?? skillName,
  }).filter((i) => i !== "variant-suffix");
  let overlap: RoutingAssessment["overlap"] = null;
  if (contractIssues.length === 0 && description) {
    const index = await cachedLiveSkillIndex();
    const hit = findDescriptionOverlap(description, index, { excludeName: skillName });
    if (hit && index.find((e) => e.name === hit.name)?.contractCompliant) {
      overlap = {
        name: hit.name,
        tokens: hit.tokens,
        containment: hit.containment,
        bigrams: hit.bigrams,
      };
    }
  }
  return { contractIssues, overlap };
}

export type IncomingSkillSummary = {
  name: string;
  origin: IncomingSkillOrigin;
  author_peer_id?: string;
  timestamp?: number;
  description?: string;
  category?: string;
  tags?: string[];
  signatureValid?: boolean;
  injectionScan?: { severity?: InjectionSeverity; matches?: number };
  /** PLAN-44 Phase 5b: contract / overlap assessment recorded at ingest; `hold` when it kept the skill out of the live set. */
  routing?: RoutingAssessment & { hold: boolean; summary: string };
  provenance?: Record<string, unknown>;
  contentHash?: string;
  expiresAt?: number;
};

/** The synthetic peer id the skill-seekers harvester stamps on local scrapes. */
const LOCAL_SCRAPE_PEER_IDS = new Set([
  "local-skill-seekers",
  "local-skill-seek",
  "agentskills.io",
]);

function classifyIncomingOrigin(params: {
  envelope: SkillEnvelope | undefined;
  decodedSkillMd: string | undefined;
  description: string | undefined;
}): IncomingSkillOrigin {
  const { envelope, decodedSkillMd, description } = params;
  // No parseable envelope = an interrupted/corrupt write, NOT an anonymous peer.
  if (!envelope) return "incomplete";
  // Envelopes written since the origin fix carry it explicitly.
  const stamped = (envelope as unknown as { origin?: string }).origin;
  if (stamped === "external-scrape") return "external-scrape";
  if (stamped === "local-dream") return "local-dream";
  // Back-compat classification for envelopes written before the origin field.
  if (envelope.author_peer_id && LOCAL_SCRAPE_PEER_IDS.has(envelope.author_peer_id)) {
    return "external-scrape";
  }
  const md = decodedSkillMd ?? "";
  if (description === "Dream-generated skill crystal" || /\bcrystal_id:/.test(md)) {
    return "local-dream";
  }
  return "peer";
}

function extractDescriptionFromFrontmatter(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const block = content.slice(3, end);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("description:")) {
      const value = line.slice("description:".length).trim();
      // Strip surrounding quotes if present.
      return value.replace(/^"|"$/g, "").replace(/^'|'$/g, "") || undefined;
    }
  }
  return undefined;
}

export async function listIncomingSkills(config: BitterbotConfig): Promise<IncomingSkillSummary[]> {
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  try {
    const entries = await fs.readdir(quarantineDir, { withFileTypes: true });
    const skills: IncomingSkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const envelopePath = path.join(quarantineDir, entry.name, ".envelope.json");
      let envelope: SkillEnvelope | undefined;
      let envelopeMeta: Record<string, unknown> | undefined;
      try {
        const raw = await fs.readFile(envelopePath, "utf-8");
        envelope = parseEnvelopeJson(raw);
        envelopeMeta = envelope as unknown as Record<string, unknown>;
      } catch {}
      let description: string | undefined;
      let decodedSkillMd: string | undefined;
      if (envelope?.skill_md) {
        try {
          decodedSkillMd = Buffer.from(envelope.skill_md, "base64").toString("utf-8");
          description = extractDescriptionFromFrontmatter(decodedSkillMd);
        } catch {}
      }
      // Fall back to reading SKILL.md directly when the envelope lacks the body
      // (e.g. an interrupted write) so we can still classify origin.
      if (!decodedSkillMd) {
        try {
          decodedSkillMd = await fs.readFile(
            path.join(quarantineDir, entry.name, "SKILL.md"),
            "utf-8",
          );
          description = description ?? extractDescriptionFromFrontmatter(decodedSkillMd);
        } catch {}
      }
      const origin = classifyIncomingOrigin({ envelope, decodedSkillMd, description });
      const injectionScan = envelopeMeta?.injection_scan as
        | { severity?: InjectionSeverity; matches?: { length?: number } | unknown[] }
        | undefined;
      const matchesLen = Array.isArray(injectionScan?.matches)
        ? injectionScan.matches.length
        : (injectionScan?.matches as { length?: number } | undefined)?.length;
      skills.push({
        name: entry.name,
        origin,
        author_peer_id: envelope?.author_peer_id,
        timestamp: envelope?.timestamp,
        description,
        category: envelope?.category,
        tags: envelope?.tags,
        signatureValid: envelope ? verifySignature(envelope) : undefined,
        injectionScan: injectionScan
          ? { severity: injectionScan.severity, matches: matchesLen }
          : undefined,
        routing: (() => {
          const r = envelopeMeta?.routing as RoutingAssessment | undefined;
          return r
            ? { ...r, hold: envelopeMeta?.routing_hold === true, summary: describeRouting(r) }
            : undefined;
        })(),
        provenance: envelope?.provenance,
        contentHash: envelope?.content_hash,
        expiresAt: envelope?.expires_at,
      });
    }
    return skills;
  } catch {
    return [];
  }
}

function verifySignature(envelope: SkillEnvelope): boolean {
  try {
    const pubkeyBytes = Buffer.from(envelope.author_pubkey, "base64");
    const signatureBytes = Buffer.from(envelope.signature, "base64");
    const skillBytes = Buffer.from(envelope.skill_md, "base64");

    // Ed25519 verification: construct SPKI DER from raw 32-byte pubkey
    const spkiDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubkeyBytes]);
    const publicKey = createPublicKey({
      key: spkiDer,
      format: "der",
      type: "spki",
    });
    return verify(null, skillBytes, publicKey, signatureBytes);
  } catch (err) {
    log.debug(`Signature verification error: ${String(err)}`);
    return false;
  }
}

function validateSkillContent(content: string): boolean {
  if (!content.startsWith("---")) return false;
  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return false;
  const frontmatter = content.slice(3, endIdx);
  return frontmatter.includes("name:");
}

function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function checkRateLimit(peerId: string, maxPerHour: number): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  let state = peerRates.get(peerId);
  if (!state || now - state.windowStart > windowMs) {
    state = { count: 0, windowStart: now };
    peerRates.set(peerId, state);
  }
  if (state.count >= maxPerHour) {
    return false;
  }
  state.count++;
  return true;
}

async function skillExistsWithHash(skillsDir: string, contentHash: string): Promise<boolean> {
  // Simple check: walk existing skills and compare hashes
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(skillsDir, entry.name, ".provenance.json");
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
        if (meta.content_hash === contentHash) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// ── PLAN-45 Phase 3.4: peer retractions ──────────────────────────────────

const RETRACTIONS_FILENAME = "retractions.jsonl";

interface RetractionRow {
  direction: "peer" | "own";
  author_pubkey?: string;
  contentSha256?: string;
}

let retractionsCache: { mtimeMs: number; size: number; keys: Set<string> } | null = null;

function retractionsFile(): string {
  return path.join(resolveWikiDir(), RETRACTIONS_FILENAME);
}

/** Whether (author pubkey, content hash) was retracted by a peer stub we applied. Memoized on the ledger's mtime. */
export async function isRetracted(authorPubkey: string, contentHash: string): Promise<boolean> {
  const file = retractionsFile();
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(file);
  } catch {
    retractionsCache = null;
    return false;
  }
  if (
    !retractionsCache ||
    retractionsCache.mtimeMs !== st.mtimeMs ||
    retractionsCache.size !== st.size
  ) {
    const keys = new Set<string>();
    try {
      for (const line of (await fs.readFile(file, "utf-8")).split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as RetractionRow;
          if (row.direction === "peer" && row.author_pubkey && row.contentSha256) {
            keys.add(`${row.author_pubkey} ${row.contentSha256}`);
          }
        } catch {
          // malformed line
        }
      }
    } catch {
      // unreadable: treat as empty
    }
    retractionsCache = { mtimeMs: st.mtimeMs, size: st.size, keys };
  }
  return retractionsCache.keys.has(`${authorPubkey} ${contentHash}`);
}

async function readJsonField(file: string, field: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Apply a retraction stub: drop the quarantined copy, archive and remove
 * the live copy, remember the pair. Matching is by the ORIGINAL envelope's
 * author pubkey and content hash as recorded on the copy; the stub's own
 * name is informational.
 */
async function applyPeerRetraction(params: {
  envelope: SkillEnvelope;
  retraction: EvolutionRetractionRecord;
  config: BitterbotConfig;
}): Promise<IngestResult> {
  const { envelope, retraction, config } = params;
  const pubkey = envelope.author_pubkey;
  const hash = retraction.contentSha256;
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const liveRoot = path.join(CONFIG_DIR, "skills");
  const removed: string[] = [];
  let changed = false;

  // Quarantine copies.
  try {
    for (const entry of await fs.readdir(quarantineDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(quarantineDir, entry.name);
      const envFile = path.join(dir, ".envelope.json");
      if (
        (await readJsonField(envFile, "author_pubkey")) === pubkey &&
        (await readJsonField(envFile, "content_hash")) === hash
      ) {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(`quarantine:${entry.name}`);
        changed = true;
      }
    }
  } catch {
    // no quarantine dir
  }

  // Live copies: archive first (with the provenance stamped), then remove.
  try {
    for (const entry of await fs.readdir(liveRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(liveRoot, entry.name);
      const provFile = path.join(dir, ".provenance.json");
      if (
        (await readJsonField(provFile, "author_pubkey")) !== pubkey ||
        (await readJsonField(provFile, "content_hash")) !== hash
      ) {
        continue;
      }
      let content: string | null = null;
      try {
        content = await fs.readFile(path.join(dir, "SKILL.md"), "utf-8");
      } catch {
        content = null;
      }
      if (content) {
        try {
          let provenance = "";
          try {
            const parsed = JSON.parse(await fs.readFile(provFile, "utf-8")) as Record<
              string,
              unknown
            >;
            provenance = JSON.stringify(
              { ...parsed, retracted: { at: Date.now(), reason: retraction.reason } },
              null,
              2,
            );
          } catch {
            provenance = "";
          }
          await archiveVersion(resolveStorageRoots(), {
            name: entry.name,
            content,
            reason: `peer retraction (${retraction.reason || "no reason given"})`,
            author: envelope.author_peer_id,
            sidecars: provenance ? { ".provenance.json": provenance } : {},
          });
        } catch (err) {
          log.debug(`archive of retracted ${entry.name} skipped: ${String(err)}`);
        }
      }
      for (const file of ["SKILL.md", ".provenance.json", ".evidence.json"]) {
        await fs.rm(path.join(dir, file), { force: true });
      }
      try {
        await fs.rmdir(dir);
      } catch {
        // attachments keep the dir; the index is SKILL.md-driven
      }
      removed.push(`live:${entry.name}`);
      changed = true;
      await appendImpactEntry({
        source: "evolution",
        action: "peer-retraction",
        skillName: entry.name,
        verdict: "rolled-back",
        detail: `retracted by its author ${envelope.author_peer_id}: ${retraction.reason || "no reason given"}`,
        contentHash: hash,
      });
    }
  } catch {
    // no live root
  }

  const file = retractionsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(
    file,
    `${JSON.stringify({
      direction: "peer",
      author_pubkey: pubkey,
      author_peer_id: envelope.author_peer_id,
      contentSha256: hash,
      name: retraction.name,
      reason: retraction.reason,
      retractedAt: retraction.retractedAt,
      receivedAt: Date.now(),
      removed,
    })}\n`,
    "utf-8",
  );
  retractionsCache = null;
  if (changed) {
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: liveRoot });
  }
  log.info(
    `Applied retraction of ${retraction.name} (${hash.slice(0, 12)}) from ${envelope.author_peer_id}: ${removed.length > 0 ? removed.join(", ") : "no local copy"}`,
  );
  return {
    ok: true,
    action: "retracted",
    skillName: normalizeSkillName(retraction.name),
    reason: removed.length > 0 ? `removed ${removed.join(", ")}` : "no local copy",
  };
}
