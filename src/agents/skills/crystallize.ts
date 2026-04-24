/**
 * Skill Crystallization Pipeline
 *
 * Receives crystallization candidates from agent sessions (successful tool chains
 * with reward > 0.85), generates SKILL.md files, validates them against the
 * BitterbotSkillMetadata schema, and optionally publishes to the P2P network.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { BitterbotConfig } from "../../config/config.js";
import type { OrchestratorBridge } from "../../infra/orchestrator-bridge.js";
import type { CrystallizationCandidate } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR } from "../../utils.js";
import { bumpSkillsSnapshotVersion } from "./refresh.js";

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
}): Promise<CrystallizationResult> {
  const { candidate, config, bridge, workspaceDir } = params;

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

  // 4. Write to skills directory
  const skillsDir = path.join(CONFIG_DIR, "skills", skillName);
  await fs.mkdir(skillsDir, { recursive: true });
  const skillPath = path.join(skillsDir, "SKILL.md");
  await fs.writeFile(skillPath, skillMd, "utf-8");

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

  // 7. If P2P enabled and no upstream gate, publish to network
  let published = false;
  if (config.p2p?.enabled && bridge && !publishSkipped) {
    try {
      const base64Md = Buffer.from(skillMd, "utf-8").toString("base64");
      await bridge.publishSkill(base64Md, skillName);
      published = true;
      log.info(`Published skill to P2P network: ${skillName}`);
    } catch (err) {
      log.warn(`Failed to publish skill to P2P: ${String(err)}`);
    }
  }

  return { ok: true, skillPath, skillName, published, publishSkipped };
}

export async function crystallizeViaPython(params: {
  candidate: CrystallizationCandidate;
  config: BitterbotConfig;
  bridge?: OrchestratorBridge;
  workspaceDir?: string;
}): Promise<CrystallizationResult> {
  const { candidate } = params;

  return new Promise((resolve) => {
    const pythonScript = path.resolve(process.cwd(), "ai-engine", "skill_crystallizer.py");
    const outputDir = path.join(CONFIG_DIR, "skills");
    const input = JSON.stringify({
      task_name: candidate.taskName,
      description: candidate.description,
      reasoning_path: candidate.reasoningPath,
      commands: candidate.toolCalls.map((tc) => `${tc.tool}(${JSON.stringify(tc.args)})`),
      reward_score: candidate.rewardScore,
    });

    // Use the Python script's argparse CLI interface to avoid code injection.
    // JSON is passed via --input flag; the script parses it safely with json.loads().
    execFile(
      "python3",
      [pythonScript, "--input", input, "--output-dir", outputDir],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: String(err) });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          resolve({
            ok: result.ok,
            skillPath: result.path,
            skillName: candidate.taskName,
            error: result.error,
          });
        } catch {
          resolve({ ok: false, error: "failed to parse crystallizer output" });
        }
      },
    );
  });
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
