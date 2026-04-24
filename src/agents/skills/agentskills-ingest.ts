/**
 * agentskills.io Import Bridge — ingest layer.
 *
 * Fetches a SKILL.md from agentskills.io (or a compatible https URL) and
 * routes it through the existing skill quarantine so the accept/reject flow
 * is identical to P2P gossip. Imported skills carry an `origin` provenance
 * block that gates downstream marketplace promotion (see crystallize.ts).
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import { fetchAgentskillsSkill } from "./agentskills-fetch.js";
import { bumpSkillsSnapshotVersion } from "./refresh.js";

const log = createSubsystemLogger("skills/agentskills-ingest");

export type AgentskillsImportResult = {
  ok: boolean;
  action: "accepted" | "quarantined" | "rejected";
  skillName?: string;
  skillPath?: string;
  resolvedUrl?: string;
  contentHash?: string;
  reason?: string;
};

export async function importAgentskillsSkill(params: {
  input: string;
  config: BitterbotConfig;
  workspaceDir?: string;
}): Promise<AgentskillsImportResult> {
  const { input, config, workspaceDir } = params;
  const agentskillsConfig = config.skills?.agentskills;

  if (!agentskillsConfig?.enabled) {
    return {
      ok: false,
      action: "rejected",
      reason: "agentskills.io import is disabled (set skills.agentskills.enabled = true)",
    };
  }

  const fetched = await fetchAgentskillsSkill(input, agentskillsConfig);
  if (!fetched.ok || !fetched.content) {
    return {
      ok: false,
      action: "rejected",
      resolvedUrl: fetched.resolvedUrl,
      reason: fetched.error ?? "fetch failed",
    };
  }

  const frontmatterName = extractFrontmatterName(fetched.content);
  if (!frontmatterName) {
    return {
      ok: false,
      action: "rejected",
      resolvedUrl: fetched.resolvedUrl,
      reason: "SKILL.md missing name field",
    };
  }

  const skillName = normalizeSkillName(frontmatterName);
  if (!skillName) {
    return {
      ok: false,
      action: "rejected",
      resolvedUrl: fetched.resolvedUrl,
      reason: "skill name normalizes to empty",
    };
  }

  const contentHash = createHash("sha256").update(fetched.content, "utf-8").digest("hex");

  // Reject if we already have this exact content elsewhere (hash dedup).
  const existingSkillsDir = path.join(CONFIG_DIR, "skills");
  if (await skillExistsWithHash(existingSkillsDir, contentHash)) {
    return {
      ok: false,
      action: "rejected",
      resolvedUrl: fetched.resolvedUrl,
      contentHash,
      reason: "skill with identical content already installed",
    };
  }

  const origin = {
    registry: "agentskills.io",
    slug: fetched.slug,
    upstreamUrl: fetched.resolvedUrl,
  };

  const provenance = {
    registry: origin.registry,
    slug: origin.slug,
    upstream_url: origin.upstreamUrl,
    content_hash: contentHash,
    imported_at: Date.now(),
  };

  const defaultTrust = agentskillsConfig.defaultTrust ?? "review";

  if (defaultTrust === "auto") {
    const targetDir = path.join(existingSkillsDir, skillName);
    await fs.mkdir(targetDir, { recursive: true });
    const skillPath = path.join(targetDir, "SKILL.md");
    await fs.writeFile(skillPath, fetched.content, "utf-8");
    await fs.writeFile(
      path.join(targetDir, ".provenance.json"),
      JSON.stringify(provenance, null, 2),
      "utf-8",
    );
    bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "manual",
      changedPath: skillPath,
    });
    log.info(`Auto-accepted agentskills import: ${skillName} from ${fetched.resolvedUrl}`);
    return {
      ok: true,
      action: "accepted",
      skillName,
      skillPath,
      resolvedUrl: fetched.resolvedUrl,
      contentHash,
    };
  }

  // Review: write to quarantine, reuse the same directory layout as the P2P path.
  const quarantineDir =
    config.skills?.p2p?.quarantineDir ?? path.join(CONFIG_DIR, "skills-incoming");
  const incomingDir = path.join(quarantineDir, skillName);
  await fs.mkdir(incomingDir, { recursive: true });
  const skillPath = path.join(incomingDir, "SKILL.md");
  await fs.writeFile(skillPath, fetched.content, "utf-8");

  // Write a synthetic envelope so listIncomingSkills surfaces the import
  // alongside P2P quarantined skills.
  const envelope = {
    version: 1,
    name: skillName,
    author_peer_id: "agentskills.io",
    author_pubkey: "",
    timestamp: Date.now(),
    content_hash: contentHash,
    provenance,
  };
  await fs.writeFile(
    path.join(incomingDir, ".envelope.json"),
    JSON.stringify(envelope, null, 2),
    "utf-8",
  );

  log.info(`Quarantined agentskills import: ${skillName} from ${fetched.resolvedUrl}`);
  return {
    ok: true,
    action: "quarantined",
    skillName,
    skillPath,
    resolvedUrl: fetched.resolvedUrl,
    contentHash,
  };
}

function extractFrontmatterName(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const fm = content.slice(3, end);
  const match = fm.match(/^\s*name\s*:\s*(.+)\s*$/m);
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

async function skillExistsWithHash(skillsDir: string, contentHash: string): Promise<boolean> {
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
