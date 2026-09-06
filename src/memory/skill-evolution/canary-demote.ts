/**
 * PLAN-45 Phase 3.3: the demotion primitive shared by the canary monitor,
 * the cap retirement and (later) operator actions. Archive first, change
 * live second, record in the impact trail, bump the snapshot, retract on
 * the mesh when the version was published. Split out of canary-monitor.ts
 * (500-line cap).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillLifecycleStore } from "../skill-lifecycle.js";
import {
  DEFAULT_CANARY_FRACTION,
  registerCanary,
  unregisterCanary,
} from "../../agents/skills/canary-registry.js";
import { appendImpactEntry, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { bumpSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import {
  liveSkillPath,
  readArchivedSidecars,
  readLive,
  resolveStorageRoots,
  retireLive,
  rollbackToVersion,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { publishRetraction, type SkillPublisher } from "./p2p-publish.js";
import { hashProposalContent } from "./proposal-apply.js";
import { type EvolutionMeta, skillDescription } from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/canary-demote");

export async function readLiveEvolvedMeta(
  roots: StorageRoots,
  name: string,
): Promise<EvolutionMeta | null> {
  try {
    const raw = await fs.readFile(path.join(roots.liveRoot, name, ".evolution-meta.json"), "utf-8");
    const parsed = JSON.parse(raw) as EvolutionMeta;
    return parsed.origin === "wiki-evolution" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeLiveEvolvedMeta(
  roots: StorageRoots,
  name: string,
  meta: EvolutionMeta,
): Promise<void> {
  await atomicWriteJson(path.join(roots.liveRoot, name, ".evolution-meta.json"), meta);
}

export async function listLiveEvolvedMeta(
  roots: StorageRoots,
): Promise<Array<{ name: string; meta: EvolutionMeta }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(roots.liveRoot);
  } catch {
    return [];
  }
  const out: Array<{ name: string; meta: EvolutionMeta }> = [];
  for (const name of entries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      continue;
    }
    const meta = await readLiveEvolvedMeta(roots, name);
    if (meta && (await readLive(roots, name))) {
      out.push({ name, meta });
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether rolling back to `promotedFrom` restores a version WITHOUT
 * evolution identity (so the rollback frees a cap slot). Null when the
 * archive predates the sidecar manifest.
 */
export async function rollbackFreesSlot(
  roots: StorageRoots,
  name: string,
  meta: EvolutionMeta,
): Promise<boolean | null> {
  if (typeof meta.promotedFrom !== "number") {
    return null;
  }
  const sidecars = await readArchivedSidecars(roots, name, meta.promotedFrom);
  if (!sidecars) {
    return null;
  }
  return !(".evolution-meta.json" in sidecars);
}

/**
 * Take an evolved version out of service. `rollback` restores the version
 * the promotion replaced (a create, or a version with no archive, retires
 * instead); `retire` archives and removes the live copy.
 */
export async function demoteEvolved(params: {
  name: string;
  meta: EvolutionMeta;
  kind: "rollback" | "retire";
  reason: string;
  by: "monitor" | "cap" | "operator";
  stats?: Record<string, number | null>;
  storeOpts?: ImpactTrailOptions;
  lifecycleStore?: SkillLifecycleStore | null;
  publisher?: SkillPublisher | null;
  iteration?: string;
  now?: number;
}): Promise<{ action: "rolled-back" | "retired"; detail: string }> {
  const opts = params.storeOpts ?? {};
  const trailOpts = opts.configDir ? { configDir: opts.configDir } : {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const now = params.now ?? Date.now();
  const live = (await readLive(roots, params.name)) ?? "";
  const contentHash = live ? hashProposalContent(live) : undefined;
  const canRollback =
    params.kind === "rollback" && typeof params.meta.promotedFrom === "number" && live.length > 0;

  let action: "rolled-back" | "retired";
  let detail: string;
  if (canRollback) {
    const version = params.meta.promotedFrom as number;
    const restoredSidecars = await readArchivedSidecars(roots, params.name, version);
    try {
      await rollbackToVersion(roots, {
        name: params.name,
        version,
        reason: `${params.by}: ${params.reason}`,
        author: "evolution",
        timestamp: now,
      });
    } catch (err) {
      // The archive slot is gone; retiring is the only safe demotion.
      log.warn(`rollback of ${params.name} to v${version} failed (${String(err)}); retiring`);
      return demoteEvolved({ ...params, kind: "retire" });
    }
    const restoredMeta = await readLiveEvolvedMeta(roots, params.name);
    if (restoredSidecars === null && restoredMeta) {
      // Pre-manifest archive: the live meta still describes the demoted
      // bytes. Mark it so nothing treats the dir as a validated version.
      await writeLiveEvolvedMeta(roots, params.name, {
        ...restoredMeta,
        ladder: {
          state: "rolled-back",
          at: now,
          by: params.by === "cap" ? "monitor" : params.by,
          reason: params.reason,
          previous: restoredMeta.ladder?.state,
        },
        published: undefined,
        canary: restoredMeta.canary ? { ...restoredMeta.canary, endedAt: now } : undefined,
      });
    } else if (restoredMeta?.ladder?.state === "canary") {
      // The restored version was itself mid-canary; give it a fresh window.
      const description = skillDescription((await readLive(roots, params.name)) ?? "") ?? "";
      await writeLiveEvolvedMeta(roots, params.name, {
        ...restoredMeta,
        canary: { startedAt: now, bucketFraction: DEFAULT_CANARY_FRACTION, reason: "restored" },
      });
      await registerCanary(
        params.name,
        {
          startedAt: now,
          bucketFraction: DEFAULT_CANARY_FRACTION,
          descriptionAtStart: description,
          reason: "gate",
        },
        trailOpts,
      );
    }
    if (params.lifecycleStore) {
      try {
        params.lifecycleStore.setState(params.name, "active");
      } catch {
        // cache only
      }
    }
    action = "rolled-back";
    detail = `rolled back to v${version}: ${params.reason}`;
  } else {
    const retired = await retireLive(roots, {
      name: params.name,
      reason: `${params.by}: ${params.reason}`,
      author: "evolution",
      timestamp: now,
    });
    if (params.lifecycleStore) {
      try {
        params.lifecycleStore.setState(params.name, "archived");
      } catch {
        // cache only
      }
    }
    action = "retired";
    detail = `${retired ? `archived as v${retired.archived.version}; ` : ""}${params.reason}`;
  }

  if (
    action === "rolled-back" &&
    (await readLiveEvolvedMeta(roots, params.name))?.ladder?.state !== "canary"
  ) {
    await unregisterCanary(params.name, trailOpts);
  } else if (action === "retired") {
    await unregisterCanary(params.name, trailOpts);
  }
  await appendImpactEntry(
    {
      source: "evolution",
      action: action === "rolled-back" ? "rollback" : "retire",
      skillName: params.name,
      verdict: "rolled-back",
      detail: `${params.by}: ${detail}`,
      ...(contentHash ? { contentHash } : {}),
      ...(params.stats ? { stats: params.stats } : {}),
      ...(params.iteration ? { iteration: params.iteration } : {}),
      ...(params.meta.validation?.model ? { model: params.meta.validation.model } : {}),
      timestamp: now,
    },
    trailOpts,
  );
  bumpSkillsSnapshotVersion({
    reason: "manual",
    changedPath: liveSkillPath(roots, params.name),
  });
  // 3.4: what left the node must be called back from the mesh.
  const publishedHash = params.meta.published?.contentHash;
  if (publishedHash) {
    const r = await publishRetraction({
      publisher: params.publisher ?? null,
      name: params.name,
      contentHash: publishedHash,
      reason: params.reason,
      storeOpts: trailOpts,
      now,
    });
    detail += `; ${r.detail}`;
  }
  log.info(`${action} ${params.name}: ${detail}`);
  return { action, detail };
}
