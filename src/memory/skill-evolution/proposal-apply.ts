/**
 * PLAN-42 Phase 3: proposal application — stage one atomic proposal through
 * the SICA gate. NEVER promotes: promotion belongs to the Phase 4
 * validation gate (strict F7). PURPOSE.md + .evolution-meta.json ride in
 * the staging dir; the Phase 4 promotion path carries them to live.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SkillProposal } from "./proposer.js";
import {
  appendImpactEntry,
  type ImpactTrailOptions,
  readProvenance,
} from "../../agents/skills/impact-trail.js";
import { skillManage } from "../../agents/skills/skill-manage.js";
import {
  readLive,
  resolveStorageRoots,
  stagingSkillDir,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { applyPatchOps, type ParseIssue } from "./wiki-store.js";

const log = createSubsystemLogger("skill-evolution/proposal-apply");

export interface ApplyProposalResult {
  outcome: "staged" | "no-action" | "gate-failed" | "invalid" | "duplicate-of-rejected";
  detail?: string;
  stagedName?: string;
  contentHash?: string;
}

export function hashProposalContent(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

/**
 * OSS-implementation lesson: a proposer that cannot see its own rejections
 * will re-propose them forever. The impact trail records a contentHash for
 * every staged/rejected proposal; an identical (name, content) pair that
 * was previously rejected is refused without burning a validation run.
 */
async function isDuplicateOfRejected(
  skillName: string,
  contentHash: string,
  trailOpts: ImpactTrailOptions,
): Promise<boolean> {
  const trail = await readProvenance(trailOpts);
  return trail.some(
    (e) =>
      e.source === "evolution" &&
      e.skillName === skillName &&
      e.contentHash === contentHash &&
      (e.verdict === "rejected" || e.verdict === "gate-failed"),
  );
}

/**
 * Stage a proposal through the SICA gate (NEVER promotes — Phase 4 owns
 * promotion). Writes PURPOSE.md + .evolution-meta.json beside the staged
 * SKILL.md and records the verdict in the impact trail either way.
 */
export async function applyProposal(
  proposal: SkillProposal,
  deps: { storeOpts?: ImpactTrailOptions; iteration?: string },
): Promise<ApplyProposalResult> {
  const storeOpts = deps.storeOpts ?? {};
  const trailOpts = storeOpts.configDir ? { configDir: storeOpts.configDir } : {};
  const roots = resolveStorageRoots(storeOpts.configDir ? { configDir: storeOpts.configDir } : {});

  if (proposal.action === "no_action") {
    await appendImpactEntry(
      {
        source: "evolution",
        action: "propose",
        skillName: "(none)",
        verdict: "no-action",
        detail: proposal.reason ?? "proposer declined to act",
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { outcome: "no-action", ...(proposal.reason ? { detail: proposal.reason } : {}) };
  }

  let content: string;
  let purposeMd: string;
  let manageAction: "create" | "edit";
  if (proposal.action === "create") {
    const existing = await readLive(roots, proposal.name);
    if (existing !== null) {
      await appendImpactEntry(
        {
          source: "evolution",
          action: "create",
          skillName: proposal.name,
          verdict: "gate-failed",
          detail: "live skill already exists; proposer should have patched",
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
        },
        trailOpts,
      );
      return { outcome: "invalid", detail: "live skill exists; expected patch" };
    }
    content = proposal.skillMd;
    purposeMd = proposal.purposeMd;
    manageAction = "create";
  } else {
    const live = await readLive(roots, proposal.name);
    if (live === null) {
      await appendImpactEntry(
        {
          source: "evolution",
          action: "patch",
          skillName: proposal.name,
          verdict: "gate-failed",
          detail: "no live skill of that name to patch",
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
        },
        trailOpts,
      );
      return { outcome: "invalid", detail: "no live skill to patch" };
    }
    const dropped: ParseIssue[] = [];
    content = applyPatchOps(live, proposal.edits, dropped, proposal.name);
    if (content === live) {
      await appendImpactEntry(
        {
          source: "evolution",
          action: "patch",
          skillName: proposal.name,
          verdict: "no-action",
          detail: `all ${proposal.edits.length} edit(s) failed to apply (${dropped.map((d) => d.detail).join("; ")})`,
          ...(deps.iteration ? { iteration: deps.iteration } : {}),
        },
        trailOpts,
      );
      return { outcome: "no-action", detail: "patch ops did not apply" };
    }
    purposeMd = proposal.purposeNote
      ? `## Evolution History\n\n- ${new Date().toISOString()}: ${proposal.purposeNote}\n`
      : "";
    manageAction = "edit";
  }

  const contentHash = hashProposalContent(content);
  if (await isDuplicateOfRejected(proposal.name, contentHash, trailOpts)) {
    await appendImpactEntry(
      {
        source: "evolution",
        action: proposal.action,
        skillName: proposal.name,
        verdict: "gate-failed",
        detail: "identical content was previously rejected; not re-proposing",
        contentHash,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { outcome: "duplicate-of-rejected", contentHash };
  }

  const manage = await skillManage(
    { storageRoots: roots },
    {
      action: manageAction,
      name: proposal.name,
      content,
      reason: `wiki-evolution proposal (${deps.iteration ?? "manual"})`,
      author: "evolution",
    },
  );
  if (!manage.ok) {
    await appendImpactEntry(
      {
        source: "evolution",
        action: proposal.action,
        skillName: proposal.name,
        verdict: "gate-failed",
        detail: manage.detail ?? manage.gateSummary ?? "staging gate refused",
        diff: content,
        contentHash,
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { outcome: "gate-failed", detail: manage.detail ?? "gate refused", contentHash };
  }

  // Provenance rides in the staging dir; the Phase 4 promotion path carries
  // it to the live dir alongside SKILL.md.
  const stagedDir = stagingSkillDir(roots, proposal.name);
  if (purposeMd.trim()) {
    await fs.writeFile(path.join(stagedDir, "PURPOSE.md"), purposeMd, "utf-8");
  }
  await fs.writeFile(
    path.join(stagedDir, ".evolution-meta.json"),
    JSON.stringify(
      { origin: "wiki-evolution", stagedAt: Date.now(), iteration: deps.iteration ?? null },
      null,
      2,
    ),
    "utf-8",
  );
  await appendImpactEntry(
    {
      source: "evolution",
      action: proposal.action,
      skillName: proposal.name,
      verdict: "staged",
      detail: "passed staging gate; awaiting validation gate",
      diff: content,
      contentHash,
      ...(deps.iteration ? { iteration: deps.iteration } : {}),
    },
    trailOpts,
  );
  log.info(`proposal staged: ${proposal.action} ${proposal.name}`);
  return { outcome: "staged", stagedName: proposal.name, contentHash };
}
