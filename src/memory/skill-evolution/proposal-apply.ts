/**
 * PLAN-42 Phase 3: proposal application — stage one atomic proposal through
 * the SICA gate. NEVER promotes: promotion belongs to the Phase 4
 * validation gate (strict F7). PURPOSE.md + .evolution-meta.json ride in
 * the staging dir; the Phase 4 promotion path carries them to live.
 */

import { createHash } from "node:crypto";
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
import { parseSkillMarkdown } from "../skill-curator-judge.js";
import { atomicWriteFile, atomicWriteJson } from "./fs-atomic.js";
import { classifyRunOrigin } from "./run-origin.js";
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
/**
 * PLAN-44 Phase 3: origin-bound evidence. Which traces the proposer actually
 * read, and the trust class each came from (run-origin.ts). Carried into
 * `.evolution-meta.json` and PURPOSE.md; the validation gate HOLDs a
 * proposal whose evidence is all third-party (`untrusted-evidence-only`).
 */
export interface ProposalEvidence {
  runIds: string[];
  origins: string[];
}

export function collectProposalEvidence(
  reads: string[],
  samples: Array<{
    trace: { runId: string; sessionKey?: string | null; task?: { origin: string } | null };
  }>,
): ProposalEvidence {
  const runIds: string[] = [];
  const origins = new Set<string>();
  for (const read of reads) {
    const m = read.match(/^traces\/(.+)$/);
    if (!m) {
      continue;
    }
    const sample = samples.find((s) => s.trace.runId === m[1]);
    if (!sample || runIds.includes(sample.trace.runId)) {
      continue;
    }
    runIds.push(sample.trace.runId);
    // Same rule the sampler admitted the run under: a pre-user-stream
    // trace has no task header but does have a session key.
    origins.add(sample.trace.task?.origin ?? classifyRunOrigin(sample.trace.sessionKey));
  }
  return { runIds, origins: [...origins].toSorted() };
}

/** Parsed YAML value, so quoting or block-scalar layout changes do not count as a change (adversarial M5/L8). */
function frontmatterDescription(skillMd: string | null): string {
  if (!skillMd) {
    return "";
  }
  const fm = (parseSkillMarkdown(skillMd)?.frontmatter ?? {}) as Record<string, unknown>;
  return typeof fm.description === "string" ? fm.description.replace(/\s+/g, " ").trim() : "";
}

function descriptionChanged(live: string | null, next: string): boolean {
  return frontmatterDescription(live) !== frontmatterDescription(next);
}

export async function applyProposal(
  proposal: SkillProposal,
  deps: { storeOpts?: ImpactTrailOptions; iteration?: string; evidence?: ProposalEvidence },
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

  if (deps.evidence && deps.evidence.runIds.length === 0) {
    // Adversarial M3: ">= 4 trace reads" was prompt-only. A change proposed
    // without reading a single trace cites nothing; it is not bound to any
    // evidence and cannot be gated on origin. Refuse it in code.
    await appendImpactEntry(
      {
        source: "evolution",
        action: proposal.action,
        skillName: proposal.name,
        verdict: "gate-failed",
        detail: "proposal cites no traces (proposer read none)",
        ...(deps.iteration ? { iteration: deps.iteration } : {}),
      },
      trailOpts,
    );
    return { outcome: "invalid", detail: "proposal cites no traces" };
  }

  let content: string;
  let purposeMd: string;
  let manageAction: "create" | "edit";
  let liveForContract: string | null = null;
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
    liveForContract = live;
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
      // PLAN-44 Phase 3: a medium injection hit blocks evolution-authored content.
      strictInjection: true,
      // PLAN-44 Phase 4a: the description is the routing key; hold it to
      // the contract. A patch over a legacy skill is grandfathered unless
      // the proposer rewrote the description (then it must comply).
      descriptionContract:
        manageAction === "create" || descriptionChanged(liveForContract, content),
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
  const evidenceSection = deps.evidence
    ? `\n\n## Evidence\n\n- runs: ${deps.evidence.runIds.join(", ") || "(none read)"}\n- origins: ${deps.evidence.origins.join(", ") || "(none)"}\n`
    : "";
  if (purposeMd.trim() || evidenceSection) {
    await atomicWriteFile(
      path.join(stagedDir, "PURPOSE.md"),
      `${purposeMd.replace(/\n+$/, "")}${evidenceSection}`,
    );
  }
  await atomicWriteJson(path.join(stagedDir, ".evolution-meta.json"), {
    origin: "wiki-evolution",
    stagedAt: Date.now(),
    iteration: deps.iteration ?? null,
    // Adversarial H1: the gate re-checks this against the staged file, so a
    // later overwrite of SKILL.md under this name cannot ride the meta.
    contentHash,
    ...(deps.evidence ? { evidence: deps.evidence } : {}),
  });
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
