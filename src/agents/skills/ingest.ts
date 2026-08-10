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
import {
  type InjectionScanResult,
  type InjectionSeverity,
  scanSkillForInjection,
  shouldForceQuarantine,
} from "../../security/skill-injection-scanner.js";
import { CONFIG_DIR } from "../../utils.js";
import { bumpSkillsSnapshotVersion } from "./refresh.js";

const log = createSubsystemLogger("skills/ingest");

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
  action: "accepted" | "quarantined" | "rejected";
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
  const isLocalOrigin = origin === "external-scrape";
  const p2pConfig = config.skills?.p2p;
  const policy = p2pConfig?.ingestPolicy ?? "review";

  // Self-loopback guard: a crystal this node published can be delivered back to
  // it over gossip. Dropping it here stops the node from quarantining its own
  // output as an anonymous inbound peer skill (a source of the "received from
  // unknown peer" clutter). Local-origin ingests are exempt (they are ours by
  // definition and take the accept path below).
  if (
    !isLocalOrigin &&
    params.ownPublishPubkey &&
    envelope.author_pubkey === params.ownPublishPubkey
  ) {
    return { ok: false, action: "rejected", reason: "self-loopback (own published skill)" };
  }

  // Policy: deny all. Local-origin research output is not subject to the peer
  // ingest policy (it never touched the network) — only genuine peer skills are.
  if (policy === "deny" && !isLocalOrigin) {
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

  // 3. Content-hash dedup
  if (seenHashes.has(envelope.content_hash)) {
    return { ok: false, action: "rejected", reason: "duplicate content hash" };
  }

  // 4. Rate limiting
  const maxPerHour = p2pConfig?.maxIngestedPerHour ?? 20;
  if (!checkRateLimit(envelope.author_peer_id, maxPerHour)) {
    return { ok: false, action: "rejected", reason: "rate limit exceeded" };
  }

  // 5. Parse and validate SKILL.md
  const skillContent = skillBytes.toString("utf-8");
  if (!validateSkillContent(skillContent)) {
    return { ok: false, action: "rejected", reason: "invalid SKILL.md structure" };
  }

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

  // 8. Determine destination based on origin, policy, trust level, and scan.
  // `forceQuarantine` overrides accept when the scanner returns critical — the
  // injection scan still guards even our own scraped content. A skill is
  // accepted directly when it is local-origin (our own research) OR a trusted
  // peer under `auto` policy; everything else is held for review.
  const acceptDirectly =
    !forceQuarantine && (isLocalOrigin || (policy === "auto" && isAutoAccepted));
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

    log.info(
      `Accepted skill (${origin}): ${skillName}${isLocalOrigin ? "" : ` from ${envelope.author_peer_id}`}`,
    );
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
  await fs.writeFile(
    envelopePath,
    JSON.stringify(
      {
        ...envelope,
        origin,
        injection_scan: scanResult ?? undefined,
        force_quarantined: forceQuarantine,
      },
      null,
      2,
    ),
    "utf-8",
  );
  const skillPath = path.join(incomingDir, "SKILL.md");
  await fs.writeFile(skillPath, skillContent, "utf-8");

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

export async function acceptIncomingSkill(params: {
  skillName: string;
  config: BitterbotConfig;
  workspaceDir?: string;
}): Promise<IngestResult> {
  const { skillName, config, workspaceDir } = params;
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const incomingDir = path.join(quarantineDir, skillName);
  const skillPath = path.join(incomingDir, "SKILL.md");

  try {
    const content = await fs.readFile(skillPath, "utf-8");
    const targetDir = path.join(CONFIG_DIR, "skills", skillName);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "SKILL.md"), content, "utf-8");

    // Copy provenance if exists
    try {
      const envelope = await fs.readFile(path.join(incomingDir, ".envelope.json"), "utf-8");
      await fs.writeFile(path.join(targetDir, ".provenance.json"), envelope, "utf-8");
    } catch {}

    // Remove from quarantine
    await fs.rm(incomingDir, { recursive: true, force: true });

    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "manual",
      changedPath: path.join(targetDir, "SKILL.md"),
    });

    log.info(`Accepted incoming skill: ${skillName}`);
    return { ok: true, action: "accepted", skillName, skillPath: path.join(targetDir, "SKILL.md") };
  } catch (err) {
    return { ok: false, action: "rejected", reason: String(err) };
  }
}

export async function rejectIncomingSkill(params: {
  skillName: string;
  config: BitterbotConfig;
}): Promise<IngestResult> {
  const { skillName, config } = params;
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const incomingDir = path.join(quarantineDir, skillName);

  try {
    await fs.rm(incomingDir, { recursive: true, force: true });
    bumpSkillsSnapshotVersion({ reason: "manual", changedPath: incomingDir });
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
        envelope = JSON.parse(raw);
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
