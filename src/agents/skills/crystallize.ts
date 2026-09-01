/**
 * Skill Crystallization Pipeline
 *
 * Receives crystallization candidates from agent sessions (successful tool chains
 * with reward > 0.85), generates SKILL.md files, validates them against the
 * BitterbotSkillMetadata schema, and optionally publishes to the P2P network.
 */

import type { BitterbotConfig } from "../../config/config.js";
import type { OrchestratorBridge } from "../../infra/orchestrator-bridge.js";
import type { CrystallizationCandidate } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { appendImpactEntry } from "./impact-trail.js";
import { bumpSkillsSnapshotVersion } from "./refresh.js";
import { skillManage } from "./skill-manage.js";
import { promoteStaged } from "./skill-promote.js";
import { liveSkillPath, resolveStorageRoots } from "./skill-storage.js";

const log = createSubsystemLogger("skills/crystallize");

const SUCCESS_THRESHOLD = 0.85;
const DEFAULT_TRANSFORM_THRESHOLD = 0.5;

export type CrystallizationResult = {
  ok: boolean;
  skillPath?: string;
  skillName?: string;
  published?: boolean;
  error?: string;
  /** Set when P2P publish was intentionally withheld (e.g. upstream-attribution gate). */
  publishSkipped?: string;
};

export async function crystallizeSkill(params: {
  candidate: CrystallizationCandidate;
  config: BitterbotConfig;
  bridge?: OrchestratorBridge;
  workspaceDir?: string;
  /** Storage root override — tests only. Defaults to CONFIG_DIR. */
  configDir?: string;
}): Promise<CrystallizationResult> {
  const { candidate, config, bridge, workspaceDir, configDir } = params;

  // 1. Evaluate reward threshold
  if (candidate.rewardScore < SUCCESS_THRESHOLD) {
    return {
      ok: false,
      error: `reward score ${candidate.rewardScore} below threshold ${SUCCESS_THRESHOLD}`,
    };
  }

  // 2. Generate SKILL.md content
  const skillName = normalizeSkillName(candidate.taskName);
  const skillMd = generateSkillMd(candidate, skillName);

  // 3. Validate against schema (basic structural check)
  if (!validateSkillMd(skillMd)) {
    return { ok: false, error: "generated SKILL.md failed validation" };
  }

  // 4. Stage + behavioural gate + promote (PLAN-42 Phase 0). Crystallize is
  //    agent-originated content, so it goes through the same SICA staging
  //    gate as every other agent mutation instead of writing straight to
  //    live; the promote step archives any previous live version.
  const roots = resolveStorageRoots(configDir ? { configDir } : {});
  const trailOpts = configDir ? { configDir } : {};
  const manage = await skillManage(
    { storageRoots: roots },
    {
      action: "create",
      name: skillName,
      content: skillMd,
      reason: `crystallized from session (reward ${candidate.rewardScore})`,
      author: "agent",
      overwriteLive: true,
    },
  );
  if (!manage.ok) {
    const detail = manage.detail ?? manage.error ?? "unknown gate failure";
    await appendImpactEntry(
      {
        source: "crystallize",
        action: "create",
        skillName,
        verdict: "gate-failed",
        detail,
      },
      trailOpts,
    );
    return { ok: false, error: `staging gate refused crystallized skill: ${detail}` };
  }
  const promoted = await promoteStaged(
    { storageRoots: roots },
    { name: skillName, reason: "crystallize promote", author: "agent" },
  );
  if (!promoted.ok) {
    const detail = promoted.detail ?? promoted.error ?? "promote failed";
    await appendImpactEntry(
      {
        source: "crystallize",
        action: "promote",
        skillName,
        verdict: "rejected",
        detail,
      },
      trailOpts,
    );
    return { ok: false, error: `promotion failed for crystallized skill: ${detail}` };
  }
  const skillPath = liveSkillPath(roots, skillName);
  await appendImpactEntry(
    {
      source: "crystallize",
      action: "create",
      skillName,
      verdict: "accepted",
      detail: `reward ${candidate.rewardScore}; archived previous v${promoted.previousArchived?.version ?? "none"}`,
    },
    trailOpts,
  );

  // 5. Bump skills snapshot version
  bumpSkillsSnapshotVersion({
    workspaceDir,
    reason: "manual",
    changedPath: skillPath,
  });

  log.info(`Crystallized skill: ${skillName} at ${skillPath}`);

  // 6. Marketplace promotion gate: derivatives of upstream-imported skills
  //    may not be published to the paid/P2P marketplace unless they show
  //    sufficient transformation over the original source. This is the
  //    attribution wedge — free imports stay free; genuinely new work can
  //    still be listed, and origin provenance rides along for credit.
  let publishSkipped: string | undefined;
  if (candidate.origin?.registry) {
    const threshold = config.skills?.agentskills?.transformThreshold ?? DEFAULT_TRANSFORM_THRESHOLD;
    const transformScore = candidate.transformScore ?? 0;
    if (transformScore < threshold) {
      publishSkipped = `origin=${candidate.origin.registry} transformScore=${transformScore} < threshold=${threshold}`;
      log.info(`Withholding P2P publish for ${skillName}: ${publishSkipped}`);
    }
  }

  // 7. PLAN-42 quality doctrine: crystallization no longer publishes to the
  //    P2P network directly. Nothing propagates unvalidated — a crystallized
  //    skill reaches the mesh only after it passes the evolution validation
  //    gate and matures (p2p-publish.ts sweep). The direct publish here was
  //    the sender side of the junk-crystal clutter peers quarantine.
  const published = false;
  if (config.p2p?.enabled && bridge && !publishSkipped) {
    publishSkipped =
      "direct crystal publish retired (PLAN-42): skills propagate only after validation + maturity";
    log.info(`Withholding P2P publish for ${skillName}: ${publishSkipped}`);
  }

  return { ok: true, skillPath, skillName, published, publishSkipped };
}

function normalizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function generateSkillMd(candidate: CrystallizationCandidate, skillName: string): string {
  const bins = detectRequiredBins(candidate);
  const binsYaml =
    bins.length > 0 ? `\n    bins:\n${bins.map((b) => `      - ${b}`).join("\n")}` : "";

  let md = `---
name: ${skillName}
description: ${candidate.description}
bitterbot:
  requires:${binsYaml}
  ${binsYaml ? "" : "{}"}
---

# ${candidate.taskName}

${candidate.description}

## Reasoning Path

${candidate.reasoningPath.map((step) => `1. ${step}`).join("\n")}

## Tool Sequences

\`\`\`
${candidate.toolCalls.map((tc) => `${tc.tool}(${JSON.stringify(tc.args)})`).join("\n")}
\`\`\`
`;

  // Clean up empty requires
  md = md.replace("  requires:\n  {}\n", "  requires: {}\n");

  return md;
}

function detectRequiredBins(candidate: CrystallizationCandidate): string[] {
  const bins = new Set<string>();
  for (const tc of candidate.toolCalls) {
    const tool = tc.tool.toLowerCase();
    if (tool.includes("shell") || tool.includes("exec") || tool.includes("terminal")) {
      const args = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args);
      // Detect common binaries from command strings
      const knownBins = [
        "git",
        "npm",
        "pnpm",
        "node",
        "python3",
        "cargo",
        "docker",
        "curl",
        "wget",
      ];
      for (const bin of knownBins) {
        if (args.includes(bin)) {
          bins.add(bin);
        }
      }
    }
  }
  return [...bins].sort();
}

function validateSkillMd(content: string): boolean {
  // Basic structural validation: must have frontmatter and a name
  if (!content.startsWith("---")) {
    return false;
  }
  const endOfFrontmatter = content.indexOf("---", 3);
  if (endOfFrontmatter === -1) {
    return false;
  }
  const frontmatter = content.slice(3, endOfFrontmatter);
  if (!frontmatter.includes("name:")) {
    return false;
  }
  return true;
}
