import { createHash } from "node:crypto";
import { listLiveSkillIndex } from "../agents/skills/description-overlap.js";
import { appendImpactEntry } from "../agents/skills/impact-trail.js";
import { runSkillGate, formatGateSummary } from "../agents/skills/skill-gate.js";
import { promoteStaged } from "../agents/skills/skill-promote.js";
import {
  readLive,
  readStaged,
  stageSkill,
  updateStagingGateStatus,
  type StorageRoots,
} from "../agents/skills/skill-storage.js";
import { compileTeachingDraft } from "./teaching-draft.js";
import type { TeachingDraftOptions, TeachingRecord } from "./teaching-types.js";

export const teachingContentHash = (content: string) =>
  createHash("sha256").update(content).digest("hex");
const authorOf = (record: TeachingRecord) => `human_demonstration:${record.id}`;

export async function stageTeachingSkill(
  record: TeachingRecord,
  options: TeachingDraftOptions,
  roots: StorageRoots,
) {
  if (record.status === "saved")
    throw new Error("This recording already has a saved skill. Edit it in Skills.");
  if (record.skillName && record.skillName !== options.name)
    throw new Error("Keep the staged skill name, or start a new draft.");
  const content = compileTeachingDraft(record, options);
  if ((await readLive(roots, options.name)) !== null)
    throw new Error("A live skill already uses that name. Choose another name.");
  const existing = await readStaged(roots, options.name);
  if (existing && existing.meta.author !== authorOf(record))
    throw new Error("Another candidate already uses that name. Choose another name.");
  const gate = runSkillGate({
    skillName: options.name,
    stagedContent: content,
    strictInjection: true,
    descriptionContract: true,
    liveIndex: await listLiveSkillIndex(roots),
  });
  // A blocked draft never replaces an earlier reviewed candidate.
  if (gate.outcome === "fail")
    return { ok: false, content, gate, summary: formatGateSummary(gate) };
  await stageSkill(roots, {
    name: options.name,
    content,
    reason: "Owner demonstrated a browser workflow",
    author: authorOf(record),
    overwrite: !!existing,
  });
  await updateStagingGateStatus(roots, options.name, "passed");
  record.status = "staged";
  record.skillName = options.name;
  record.draftOptions = options;
  record.contentHash = teachingContentHash(content);
  return { ok: true, content, hash: record.contentHash, gate, summary: formatGateSummary(gate) };
}

/** Owner approval of the exact reviewed bytes; never an evolution-gate override. */
export async function activateTeachingSkill(
  record: TeachingRecord,
  reviewedHash: string,
  roots: StorageRoots,
) {
  if (!record.skillName || !record.contentHash || reviewedHash !== record.contentHash)
    throw new Error("Review the latest draft before saving it.");
  const live = await readLive(roots, record.skillName);
  // Recover if publishing succeeded but recording/audit persistence failed.
  if (
    (record.status === "staged" || record.status === "saved") &&
    live !== null &&
    teachingContentHash(live) === reviewedHash
  ) {
    record.status = "saved";
    return { ok: true, name: record.skillName };
  }
  if (record.status !== "staged" || live !== null)
    throw new Error("This draft is no longer available for activation.");
  const staged = await readStaged(roots, record.skillName);
  if (
    !staged ||
    staged.meta.author !== authorOf(record) ||
    teachingContentHash(staged.content) !== reviewedHash
  )
    throw new Error("The staged skill changed. Review it again.");
  const gate = runSkillGate({
    skillName: record.skillName,
    stagedContent: staged.content,
    strictInjection: true,
    descriptionContract: true,
    liveIndex: await listLiveSkillIndex(roots),
  });
  if (gate.outcome === "fail") throw new Error(formatGateSummary(gate));
  const result = await promoteStaged(
    { storageRoots: roots },
    {
      name: record.skillName,
      author: authorOf(record),
      reason: "Owner reviewed a demonstrated workflow; task competence is unverified",
      expectedContent: staged.content,
      createOnly: true,
    },
  );
  if (!result.ok) throw new Error(result.detail ?? "The skill could not be activated.");
  record.status = "saved";
  return { ok: true, name: record.skillName };
}

export async function auditTeachingActivation(record: TeachingRecord) {
  await appendImpactEntry({
    source: "skill-manage",
    action: "promote",
    skillName: record.skillName!,
    verdict: "accepted",
    detail: `owner-reviewed human demonstration ${record.id}; no measured competence or network publication claimed`,
  });
}
