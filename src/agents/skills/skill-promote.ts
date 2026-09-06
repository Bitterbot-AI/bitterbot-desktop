/**
 * Promote staged skill content to live. Handles three staging payloads:
 *
 *  1. Regular content — snapshot prior live to archive, atomic-rename
 *     staged → live.
 *  2. Tombstone manifest — snapshot prior live to archive, remove from
 *     live, mark lifecycle as archived.
 *  3. Consolidate manifest — snapshot prior live (source) to archive,
 *     remove from live, call lifecycleStore.consolidateInto(source, target).
 *
 * The gate must have passed (`gateStatus === "passed"`) for the promotion
 * to proceed; an explicit `forceGate` flag lets the operator override.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { unregisterCanary } from "./canary-registry.js";
import {
  readConsolidateTarget,
  stagedIsConsolidateManifest,
  stagedIsTombstone,
} from "./skill-manage.js";
import {
  type ArchivedVersion,
  archiveVersion,
  discardStaged,
  liveSkillDir,
  liveSkillPath,
  readLive,
  readStaged,
  rollbackToVersion,
  stagingSkillDir,
  type StorageRoots,
} from "./skill-storage.js";
import { publishStaged as storagePublishStaged } from "./skill-storage.js";

const log = createSubsystemLogger("skills/promote");

export interface PromoteContext {
  storageRoots: StorageRoots;
  lifecycleStore?: SkillLifecycleStore;
}

export interface PromoteParams {
  name: string;
  reason?: string;
  author?: string;
  /** When true, promote even if the staging gate did not pass. */
  forceGate?: boolean;
  /**
   * PLAN-44 Phase 3: content staged by the evolution pipeline (carrying
   * `.evolution-meta.json`) is promoted ONLY by the validation gate, or by
   * an operator override. The agent's `skill_manage` tool never sets this.
   */
  allowEvolutionStaged?: boolean;
  /** Override timestamp for tests. */
  timestamp?: number;
}

/** Sidecars the evolution pipeline writes beside a staged SKILL.md. */
export const EVOLUTION_SIDECARS = [".evolution-meta.json", "PURPOSE.md"] as const;

async function readStagedSidecars(roots: StorageRoots, name: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of EVOLUTION_SIDECARS) {
    try {
      out.set(file, await fs.readFile(path.join(stagingSkillDir(roots, name), file), "utf-8"));
    } catch {
      // absent
    }
  }
  return out;
}

export type PromoteKind = "edit" | "tombstone" | "consolidate";

export interface PromoteResult {
  ok: boolean;
  kind?: PromoteKind;
  /** New live content after promotion (empty for tombstones). */
  liveContent?: string;
  /** Archived version of the *previous* live, if any. */
  previousArchived: ArchivedVersion | null;
  error?:
    | "no-staged"
    | "gate-not-passed"
    | "tombstone-no-live"
    | "consolidate-target-missing"
    | "consolidate-missing-target-field"
    | "evolution-staged"
    | "storage-error";
  detail?: string;
}

async function deleteLive(roots: StorageRoots, name: string): Promise<void> {
  // Remove just the SKILL.md and the directory if empty. We never recursively
  // delete because skill directories may grow user-supplied attachments later.
  try {
    await fs.unlink(liveSkillPath(roots, name));
  } catch {
    // already gone
  }
  try {
    await fs.rmdir(liveSkillDir(roots, name));
  } catch {
    // directory not empty or already removed
  }
}

export async function promoteStaged(
  ctx: PromoteContext,
  params: PromoteParams,
): Promise<PromoteResult> {
  const staged = await readStaged(ctx.storageRoots, params.name);
  if (!staged) {
    return {
      ok: false,
      previousArchived: null,
      error: "no-staged",
      detail: `no staged content for "${params.name}"`,
    };
  }
  if (!params.forceGate && staged.meta.gateStatus !== "passed") {
    return {
      ok: false,
      previousArchived: null,
      error: "gate-not-passed",
      detail: `gate status is "${staged.meta.gateStatus ?? "pending"}"; pass forceGate=true to override`,
    };
  }

  // PLAN-44 Phase 3 (audit security finding 2): evolution-staged content
  // used to be promotable by the agent's own skill_manage tool, and the
  // promoted copy lost its .evolution-meta.json — escaping the evolved-skill
  // cap, the P2P doctrine and the validation summaries. Read the sidecars
  // BEFORE publish (publish discards staging) and carry them to live.
  const sidecars = await readStagedSidecars(ctx.storageRoots, params.name);
  if (sidecars.has(".evolution-meta.json") && !params.allowEvolutionStaged) {
    return {
      ok: false,
      previousArchived: null,
      error: "evolution-staged",
      detail: `"${params.name}" was staged by the skill-evolution pipeline; only its validation gate (or an operator override) promotes it`,
    };
  }

  const author = params.author ?? staged.meta.author;
  const reason = params.reason ?? `promote staging (${staged.meta.reason})`;

  // ── Tombstone path ───────────────────────────────────────────────────
  if (stagedIsTombstone(staged.content)) {
    const prevLive = await readLive(ctx.storageRoots, params.name);
    if (!prevLive) {
      // Nothing live to archive; treat as a no-op but discard the staging.
      await discardStaged(ctx.storageRoots, params.name);
      return {
        ok: false,
        kind: "tombstone",
        previousArchived: null,
        error: "tombstone-no-live",
        detail: "tombstone promoted with no live content",
      };
    }
    const previousArchived = await archiveVersion(ctx.storageRoots, {
      name: params.name,
      content: prevLive,
      reason: `pre-delete snapshot (${reason})`,
      author,
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
    });
    await deleteLive(ctx.storageRoots, params.name);
    await discardStaged(ctx.storageRoots, params.name);
    if (ctx.lifecycleStore) {
      ctx.lifecycleStore.setState(params.name, "archived");
    }
    log.debug(`promoted tombstone for ${params.name} (v${previousArchived.version})`);
    return {
      ok: true,
      kind: "tombstone",
      previousArchived,
    };
  }

  // ── Consolidate path ─────────────────────────────────────────────────
  if (stagedIsConsolidateManifest(staged.content)) {
    const target = readConsolidateTarget(staged.content);
    if (!target) {
      return {
        ok: false,
        kind: "consolidate",
        previousArchived: null,
        error: "consolidate-missing-target-field",
        detail: "staged consolidate manifest had no 'into' field",
      };
    }
    const targetLive = await readLive(ctx.storageRoots, target);
    if (!targetLive) {
      return {
        ok: false,
        kind: "consolidate",
        previousArchived: null,
        error: "consolidate-target-missing",
        detail: `consolidation target "${target}" not live`,
      };
    }
    const prevLive = await readLive(ctx.storageRoots, params.name);
    let previousArchived: ArchivedVersion | null = null;
    if (prevLive) {
      previousArchived = await archiveVersion(ctx.storageRoots, {
        name: params.name,
        content: prevLive,
        reason: `pre-consolidate snapshot into ${target} (${reason})`,
        author,
        ...(params.timestamp ? { timestamp: params.timestamp } : {}),
      });
      await deleteLive(ctx.storageRoots, params.name);
    }
    await discardStaged(ctx.storageRoots, params.name);
    if (ctx.lifecycleStore) {
      ctx.lifecycleStore.consolidateInto(params.name, target);
    }
    log.debug(
      `promoted consolidate manifest: ${params.name} → ${target} (v${previousArchived?.version ?? "n/a"})`,
    );
    return { ok: true, kind: "consolidate", previousArchived };
  }

  // ── Regular content path ─────────────────────────────────────────────
  try {
    const published = await storagePublishStaged(ctx.storageRoots, {
      name: params.name,
      reason,
      author,
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
    });
    for (const file of EVOLUTION_SIDECARS) {
      const content = sidecars.get(file);
      const target = path.join(liveSkillDir(ctx.storageRoots, params.name), file);
      if (content !== undefined) {
        await fs.writeFile(target, content, "utf-8");
      } else {
        // Adversarial L10: a human/agent edit replacing an evolved skill
        // ends its evolution identity (cap, P2P doctrine, summaries).
        await fs.rm(target, { force: true });
      }
    }
    return {
      ok: true,
      kind: "edit",
      liveContent: published.publishedContent,
      previousArchived: published.previousArchived,
    };
  } catch (err) {
    return {
      ok: false,
      previousArchived: null,
      error: "storage-error",
      detail: String(err),
    };
  }
}

export interface RollbackParams {
  name: string;
  version: number;
  reason?: string;
  author?: string;
  timestamp?: number;
}

export interface RollbackResult {
  ok: boolean;
  /** Archive entry produced from the current live before the rollback. */
  previousArchived: ArchivedVersion | null;
  /** The restored content now in live. */
  restoredContent?: string;
  error?: "storage-error";
  detail?: string;
}

export async function rollbackStaged(
  ctx: PromoteContext,
  params: RollbackParams,
): Promise<RollbackResult> {
  try {
    const result = await rollbackToVersion(ctx.storageRoots, {
      name: params.name,
      version: params.version,
      reason: params.reason ?? `manual rollback to v${params.version}`,
      author: params.author ?? "user",
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
    });
    if (ctx.lifecycleStore) {
      // Restoring to an archived version implicitly reactivates the skill.
      ctx.lifecycleStore.setState(params.name, "active");
    }
    // PLAN-45 Phase 3 (adversarial 3-10): an operator rollback closes the
    // canary window unless the restored version is itself a canary.
    try {
      const metaRaw = await fs
        .readFile(
          path.join(liveSkillDir(ctx.storageRoots, params.name), ".evolution-meta.json"),
          "utf-8",
        )
        .catch(() => null);
      const ladder = metaRaw
        ? (JSON.parse(metaRaw) as { ladder?: { state?: string } }).ladder?.state
        : undefined;
      if (ladder !== "canary") {
        await unregisterCanary(params.name, {
          configDir: path.dirname(ctx.storageRoots.liveRoot),
        });
      }
    } catch {
      // registry is best-effort here; the monitor removes stale entries
    }
    return {
      ok: true,
      previousArchived: result.previousArchived,
      restoredContent: result.restoredContent,
    };
  } catch (err) {
    return {
      ok: false,
      previousArchived: null,
      error: "storage-error",
      detail: String(err),
    };
  }
}
