/**
 * skill_manage orchestrator: typed actions that stage skill mutations,
 * run the behavioural gate, and (separately) request publish via the
 * Phase 2c gateway methods.
 *
 * Five actions, mirroring Hermes' `skill_manage` tool surface but with
 * Bitterbot's staging-gate semantics:
 *
 *   - create: stage a brand-new skill. Refuses if a live skill already
 *     exists at the same name unless overwrite=true is supplied.
 *   - edit: stage a full-body rewrite of an existing live skill.
 *   - patch: stage a narrow substring replacement on an existing live skill.
 *     First/longest match wins; `replaceAll=true` rewrites every occurrence.
 *   - delete: stage a tombstone marker that the publish path interprets as
 *     "archive the live copy and remove from disk". No content rewrite here.
 *   - consolidate: stage a no-op (no content change) and emit a manifest
 *     pointing at the consolidation target. Publish picks this up and
 *     archives the source while leaving the target untouched.
 *
 * Every action returns a `SkillManageResult` containing the gate result,
 * the staged file path, and a structured outcome — callers can decide
 * whether to surface the gate decision to the user or auto-publish on
 * `pass`.
 */

import type { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatGateSummary, type GateResult, runSkillGate } from "./skill-gate.js";
import {
  type StorageRoots,
  SkillStorageError,
  readLive,
  readStaged,
  stageSkill,
  updateStagingGateStatus,
} from "./skill-storage.js";

const log = createSubsystemLogger("skills/manage");

export type SkillManageAction = "create" | "edit" | "patch" | "delete" | "consolidate";

export interface SkillManageBaseParams {
  /** The skill being mutated. */
  name: string;
  /** Free-form reason recorded into staging meta. */
  reason: string;
  /** Author identifier ("agent", "user", "curator"). */
  author: string;
  /** Override timestamp for test determinism. */
  timestamp?: number;
}

export interface SkillManageCreateParams extends SkillManageBaseParams {
  action: "create";
  /** Full SKILL.md content (with frontmatter). */
  content: string;
  /** Permit clobbering an existing live skill. */
  overwriteLive?: boolean;
}

export interface SkillManageEditParams extends SkillManageBaseParams {
  action: "edit";
  /** New full SKILL.md content. */
  content: string;
  /** Bypass the regression-risk gate when set. */
  acceptHighRiskDiff?: boolean;
}

export interface SkillManagePatchParams extends SkillManageBaseParams {
  action: "patch";
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  /** Bypass the regression-risk gate when set. */
  acceptHighRiskDiff?: boolean;
}

export interface SkillManageDeleteParams extends SkillManageBaseParams {
  action: "delete";
  /** Free-form note recorded in the tombstone manifest. */
  note?: string;
}

export interface SkillManageConsolidateParams extends SkillManageBaseParams {
  action: "consolidate";
  /** Skill name to consolidate INTO (must exist live). */
  into: string;
}

export type SkillManageParams =
  | SkillManageCreateParams
  | SkillManageEditParams
  | SkillManagePatchParams
  | SkillManageDeleteParams
  | SkillManageConsolidateParams;

export type SkillManageError =
  | "live-exists"
  | "live-missing"
  | "patch-no-match"
  | "patch-ambiguous"
  | "consolidate-target-missing"
  | "gate-failed"
  | "tool-unavailable"
  | "storage-error";

export interface SkillManageResult {
  ok: boolean;
  action: SkillManageAction;
  name: string;
  /** Path to the file written into staging (for content-bearing actions). */
  stagedFilePath?: string;
  /** Gate evaluation, present when the action wrote content. */
  gate?: GateResult;
  /** Human-readable gate summary. */
  gateSummary?: string;
  /** Failure reason on !ok. */
  error?: SkillManageError;
  detail?: string;
}

const TOMBSTONE_PREFIX = "---\n# skill_manage tombstone\n";

function isTombstone(content: string): boolean {
  return content.startsWith(TOMBSTONE_PREFIX);
}

/**
 * Compose a tombstone "content" body — kept as a parseable SKILL.md with a
 * synthetic frontmatter that the publish step recognises. We avoid touching
 * the live file here.
 */
function buildTombstone(name: string, reason: string, note: string | undefined): string {
  const noteLine = note ? `\nnote: ${JSON.stringify(note)}` : "";
  return `${TOMBSTONE_PREFIX}name: ${name}\ndescription: "scheduled for delete"\ntombstone:\n  reason: ${JSON.stringify(reason)}${noteLine}\n---\nThis skill is scheduled for deletion. Publish moves the live copy to the archive and removes it from disk.\n`;
}

function buildConsolidateManifest(name: string, into: string, reason: string): string {
  return `---\n# skill_manage consolidate manifest\nname: ${name}\ndescription: "consolidating into ${into}"\nconsolidate:\n  into: ${JSON.stringify(into)}\n  reason: ${JSON.stringify(reason)}\n---\nThis skill is being consolidated into \`${into}\`. Publish archives the source and updates the lifecycle store.\n`;
}

export interface SkillManageContext {
  storageRoots: StorageRoots;
  lifecycleStore?: SkillLifecycleStore;
}

/** Apply a substring patch against the source content. */
export function applySubstringPatch(params: {
  source: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): { content: string; replacedCount: number } | { error: SkillManageError; detail: string } {
  if (!params.oldString) {
    return { error: "patch-no-match", detail: "oldString cannot be empty" };
  }
  if (params.replaceAll) {
    const before = params.source;
    const after = before.split(params.oldString).join(params.newString);
    if (before === after) {
      return { error: "patch-no-match", detail: `no occurrences of oldString found` };
    }
    const replacedCount =
      before.length -
        after.length +
        (params.newString.length - params.oldString.length) *
          ((before.length - after.length) / (params.oldString.length - params.newString.length) ||
            0) || 0;
    // The arithmetic above is brittle for empty-newString cases; recount.
    const count = before.split(params.oldString).length - 1;
    return { content: after, replacedCount: count };
  }
  const idx = params.source.indexOf(params.oldString);
  if (idx < 0) {
    return { error: "patch-no-match", detail: "oldString not found in source" };
  }
  const next = params.source.indexOf(params.oldString, idx + params.oldString.length);
  if (next >= 0) {
    return {
      error: "patch-ambiguous",
      detail: "oldString appears multiple times; pass replaceAll=true or include more context",
    };
  }
  const content =
    params.source.slice(0, idx) +
    params.newString +
    params.source.slice(idx + params.oldString.length);
  return { content, replacedCount: 1 };
}

async function stageAndGate(
  ctx: SkillManageContext,
  params: {
    name: string;
    content: string;
    reason: string;
    author: string;
    timestamp?: number;
    overwriteStaging?: boolean;
    acceptHighRiskDiff?: boolean;
  },
): Promise<{ stagedFilePath: string; gate: GateResult }> {
  const staged = await stageSkill(ctx.storageRoots, {
    name: params.name,
    content: params.content,
    reason: params.reason,
    author: params.author,
    timestamp: params.timestamp,
    overwrite: params.overwriteStaging ?? true,
  });
  const liveContent = await readLive(ctx.storageRoots, params.name);
  const gate = runSkillGate({
    skillName: params.name,
    stagedContent: params.content,
    liveContent,
    ...(ctx.lifecycleStore ? { lifecycleStore: ctx.lifecycleStore } : {}),
    ...(params.acceptHighRiskDiff ? { acceptHighRiskDiff: true } : {}),
  });
  await updateStagingGateStatus(
    ctx.storageRoots,
    params.name,
    gate.outcome === "fail" ? "failed" : "passed",
    gate.outcome === "fail" ? gate.issues.find((i) => i.severity === "block")?.detail : undefined,
  );
  return { stagedFilePath: staged.filePath, gate };
}

export async function skillManage(
  ctx: SkillManageContext,
  params: SkillManageParams,
): Promise<SkillManageResult> {
  try {
    switch (params.action) {
      case "create": {
        const liveContent = await readLive(ctx.storageRoots, params.name);
        if (liveContent && !params.overwriteLive) {
          return {
            ok: false,
            action: "create",
            name: params.name,
            error: "live-exists",
            detail: `live skill "${params.name}" already exists; pass overwriteLive=true to replace`,
          };
        }
        const { stagedFilePath, gate } = await stageAndGate(ctx, {
          name: params.name,
          content: params.content,
          reason: params.reason,
          author: params.author,
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
        });
        return {
          ok: gate.outcome !== "fail",
          action: "create",
          name: params.name,
          stagedFilePath,
          gate,
          gateSummary: formatGateSummary(gate),
          ...(gate.outcome === "fail"
            ? {
                error: "gate-failed",
                detail: gate.issues
                  .filter((i) => i.severity === "block")
                  .map((i) => i.detail)
                  .join("; "),
              }
            : {}),
        };
      }

      case "edit": {
        const liveContent = await readLive(ctx.storageRoots, params.name);
        if (!liveContent) {
          return {
            ok: false,
            action: "edit",
            name: params.name,
            error: "live-missing",
            detail: `cannot edit "${params.name}": no live skill exists. Use action=create instead.`,
          };
        }
        const { stagedFilePath, gate } = await stageAndGate(ctx, {
          name: params.name,
          content: params.content,
          reason: params.reason,
          author: params.author,
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
          ...(params.acceptHighRiskDiff ? { acceptHighRiskDiff: true } : {}),
        });
        return {
          ok: gate.outcome !== "fail",
          action: "edit",
          name: params.name,
          stagedFilePath,
          gate,
          gateSummary: formatGateSummary(gate),
          ...(gate.outcome === "fail"
            ? {
                error: "gate-failed",
                detail: gate.issues
                  .filter((i) => i.severity === "block")
                  .map((i) => i.detail)
                  .join("; "),
              }
            : {}),
        };
      }

      case "patch": {
        const liveContent = await readLive(ctx.storageRoots, params.name);
        if (!liveContent) {
          return {
            ok: false,
            action: "patch",
            name: params.name,
            error: "live-missing",
            detail: `cannot patch "${params.name}": no live skill exists.`,
          };
        }
        const patched = applySubstringPatch({
          source: liveContent,
          oldString: params.oldString,
          newString: params.newString,
          ...(params.replaceAll ? { replaceAll: true } : {}),
        });
        if ("error" in patched) {
          return {
            ok: false,
            action: "patch",
            name: params.name,
            error: patched.error,
            detail: patched.detail,
          };
        }
        const { stagedFilePath, gate } = await stageAndGate(ctx, {
          name: params.name,
          content: patched.content,
          reason: `${params.reason} (patch: ${patched.replacedCount} replacement${patched.replacedCount === 1 ? "" : "s"})`,
          author: params.author,
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
          ...(params.acceptHighRiskDiff ? { acceptHighRiskDiff: true } : {}),
        });
        return {
          ok: gate.outcome !== "fail",
          action: "patch",
          name: params.name,
          stagedFilePath,
          gate,
          gateSummary: formatGateSummary(gate),
          ...(gate.outcome === "fail"
            ? {
                error: "gate-failed",
                detail: gate.issues
                  .filter((i) => i.severity === "block")
                  .map((i) => i.detail)
                  .join("; "),
              }
            : {}),
        };
      }

      case "delete": {
        const liveContent = await readLive(ctx.storageRoots, params.name);
        if (!liveContent) {
          return {
            ok: false,
            action: "delete",
            name: params.name,
            error: "live-missing",
            detail: `cannot delete "${params.name}": no live skill exists.`,
          };
        }
        const tombstone = buildTombstone(params.name, params.reason, params.note);
        const staged = await stageSkill(ctx.storageRoots, {
          name: params.name,
          content: tombstone,
          reason: `delete: ${params.reason}`,
          author: params.author,
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
          overwrite: true,
        });
        // Tombstones bypass the regression gate by construction — the
        // publish step interprets them specially. We still record gate
        // status so observers can tell the difference between a passed
        // edit and a tombstone.
        await updateStagingGateStatus(ctx.storageRoots, params.name, "passed");
        log.debug(`staged delete tombstone for ${params.name}`);
        return {
          ok: true,
          action: "delete",
          name: params.name,
          stagedFilePath: staged.filePath,
        };
      }

      case "consolidate": {
        const target = await readLive(ctx.storageRoots, params.into);
        if (!target) {
          return {
            ok: false,
            action: "consolidate",
            name: params.name,
            error: "consolidate-target-missing",
            detail: `consolidation target "${params.into}" not found in live skills`,
          };
        }
        const manifest = buildConsolidateManifest(params.name, params.into, params.reason);
        const staged = await stageSkill(ctx.storageRoots, {
          name: params.name,
          content: manifest,
          reason: `consolidate into ${params.into}: ${params.reason}`,
          author: params.author,
          ...(params.timestamp ? { timestamp: params.timestamp } : {}),
          overwrite: true,
        });
        await updateStagingGateStatus(ctx.storageRoots, params.name, "passed");
        log.debug(`staged consolidate manifest: ${params.name} → ${params.into}`);
        return {
          ok: true,
          action: "consolidate",
          name: params.name,
          stagedFilePath: staged.filePath,
        };
      }
    }
  } catch (err) {
    if (err instanceof SkillStorageError) {
      return {
        ok: false,
        action: params.action,
        name: params.name,
        error: "storage-error",
        detail: `${err.code}: ${err.message}`,
      };
    }
    throw err;
  }
}

/** True iff the staged content is a tombstone marker (for the publish path). */
export function stagedIsTombstone(content: string): boolean {
  return isTombstone(content);
}

/** Discriminator for the consolidate manifest. */
export function stagedIsConsolidateManifest(content: string): boolean {
  return content.startsWith("---\n# skill_manage consolidate manifest\n");
}

/** Extract the consolidate target from a staged manifest, or null. */
export function readConsolidateTarget(content: string): string | null {
  if (!stagedIsConsolidateManifest(content)) {
    return null;
  }
  const match = content.match(/^\s*into:\s*"([^"]+)"/m);
  return match ? (match[1] ?? null) : null;
}

/** Sanity helper — checks that staged content exists for a given name. */
export async function readStagedForPublish(
  roots: StorageRoots,
  name: string,
): Promise<{ content: string; gateOutcome: "pending" | "passed" | "failed" } | null> {
  const staged = await readStaged(roots, name);
  if (!staged) {
    return null;
  }
  return {
    content: staged.content,
    gateOutcome: staged.meta.gateStatus ?? "pending",
  };
}
