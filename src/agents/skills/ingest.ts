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
  reputationManager?: {
    getTrustLevel(pubkey: string): string;
    recordSkillReceived(pubkey: string, peerId: string): void;
    recordIngestionResult(pubkey: string, accepted: boolean): void;
  };
}): Promise<IngestResult> {
  const { envelope, config, workspaceDir } = params;
  const p2pConfig = config.skills?.p2p;
  const policy = p2pConfig?.ingestPolicy ?? "deny";

  // Policy: deny all
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

  // 8. Determine destination based on policy and trust level
  if (policy === "auto" && isAutoAccepted) {
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
          author_peer_id: envelope.author_peer_id,
          author_pubkey: envelope.author_pubkey,
          signature: envelope.signature,
          content_hash: envelope.content_hash,
          timestamp: envelope.timestamp,
          ingested_at: Date.now(),
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

    log.info(`Auto-accepted skill: ${skillName} from ${envelope.author_peer_id}`);
    params.reputationManager?.recordIngestionResult(envelope.author_pubkey, true);
    return { ok: true, action: "accepted", skillName, skillPath };
  }

  // Quarantine: write to skills-incoming directory
  const quarantineDir = p2pConfig?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const skillName = normalizeSkillName(envelope.name);
  const incomingDir = path.join(quarantineDir, skillName);
  await fs.mkdir(incomingDir, { recursive: true });
  const skillPath = path.join(incomingDir, "SKILL.md");
  await fs.writeFile(skillPath, skillContent, "utf-8");

  // Write full envelope for review
  const envelopePath = path.join(incomingDir, ".envelope.json");
  await fs.writeFile(envelopePath, JSON.stringify(envelope, null, 2), "utf-8");

  log.info(`Quarantined skill: ${skillName} from ${envelope.author_peer_id}`);
  return { ok: true, action: "quarantined", skillName, skillPath };
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
    log.info(`Rejected incoming skill: ${skillName}`);
    return { ok: true, action: "rejected", skillName };
  } catch (err) {
    return { ok: false, action: "rejected", reason: String(err) };
  }
}

export async function listIncomingSkills(config: BitterbotConfig): Promise<
  Array<{
    name: string;
    author_peer_id?: string;
    timestamp?: number;
  }>
> {
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  try {
    const entries = await fs.readdir(quarantineDir, { withFileTypes: true });
    const skills: Array<{ name: string; author_peer_id?: string; timestamp?: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const envelopePath = path.join(quarantineDir, entry.name, ".envelope.json");
      let envelope: SkillEnvelope | undefined;
      try {
        envelope = JSON.parse(await fs.readFile(envelopePath, "utf-8"));
      } catch {}
      skills.push({
        name: entry.name,
        author_peer_id: envelope?.author_peer_id,
        timestamp: envelope?.timestamp,
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
