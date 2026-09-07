/**
 * PLAN-45 5.1/5.2: resolve each arm to the skill names it puts in the
 * runtime index (or the context block it prepends), from the node's live
 * skills on disk. Origins are the sidecars the pipeline already writes.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../../src/infra/event-journal.js";
import type { EvolutionMeta } from "../../../src/memory/skill-evolution/validation-gate.js";
import type { ArmKind, ResolvedArm } from "./plan.js";
import { resolveStorageRoots } from "../../../src/agents/skills/skill-storage.js";
import {
  buildIclContext,
  type IclContext,
} from "../../../src/memory/skill-evolution/icl-context.js";

export interface LiveSkillOrigin {
  name: string;
  origin: "evolved" | "peer" | "harvested" | "local";
  evidenceRunIds: string[];
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every live skill with its origin class. */
export async function listLiveSkillOrigins(configDir?: string): Promise<LiveSkillOrigin[]> {
  const roots = resolveStorageRoots(configDir ? { configDir } : {});
  let names: string[];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name)
      .toSorted();
  } catch {
    return [];
  }
  const out: LiveSkillOrigin[] = [];
  for (const name of names) {
    const dir = path.join(roots.liveRoot, name);
    try {
      await fs.access(path.join(dir, "SKILL.md"));
    } catch {
      continue;
    }
    const meta = (await readJson(path.join(dir, ".evolution-meta.json"))) as EvolutionMeta | null;
    if (meta?.origin === "wiki-evolution") {
      const state = meta.ladder?.state;
      if (state === "rolled-back" || state === "retired" || state === "canary-off") {
        continue;
      }
      out.push({ name, origin: "evolved", evidenceRunIds: meta.evidence?.runIds ?? [] });
      continue;
    }
    if (meta?.origin === "peer") {
      out.push({ name, origin: "peer", evidenceRunIds: [] });
      continue;
    }
    const prov = await readJson(path.join(dir, ".provenance.json"));
    if (prov && (typeof prov.registry === "string" || typeof prov.author_pubkey === "string")) {
      out.push({ name, origin: "harvested", evidenceRunIds: [] });
      continue;
    }
    out.push({ name, origin: "local", evidenceRunIds: [] });
  }
  return out;
}

export interface ArmResolution {
  arms: ResolvedArm[];
  icl: IclContext[];
}

export async function resolveArms(params: {
  ids: readonly ArmKind[];
  configDir?: string;
  journal?: EventJournal | null;
  fresh?: boolean;
  /** Pre-listed live skills (one listing per run). */
  live?: LiveSkillOrigin[];
}): Promise<ArmResolution> {
  const live = params.live ?? (await listLiveSkillOrigins(params.configDir));
  // Accepted peer skills serve the runtime index the same way a harvest does.
  const harvested = live
    .filter((s) => s.origin === "harvested" || s.origin === "peer")
    .map((s) => s.name);
  const evolved = live.filter((s) => s.origin === "evolved");
  const arms: ResolvedArm[] = [];
  const icl: IclContext[] = [];
  for (const id of params.ids) {
    if (id === "none") {
      arms.push({ id, skillNames: [], contextBlock: null, note: null });
    } else if (id === "harvested") {
      arms.push({
        id,
        skillNames: harvested,
        contextBlock: null,
        note: harvested.length === 0 ? "no harvested skill is live on this node" : null,
      });
    } else if (id === "evolved") {
      arms.push({
        id,
        skillNames: evolved.map((s) => s.name),
        contextBlock: null,
        note: evolved.length === 0 ? "no evolved skill is live on this node" : null,
      });
    } else if (id === "in-context") {
      // 5.2 (adversarial 5-7): the control is PER SKILL. Each evolved skill
      // S gets a pair of arms, `evolved:S` (index = [S]) and `in-context:S`
      // (S's own evidence, no skill), so the comparison is between one
      // skill and the evidence it came from, never a concatenation.
      if (evolved.length === 0) {
        arms.push({
          id,
          skillNames: [],
          contextBlock: null,
          note: "no evolved skill to build a control for",
        });
        continue;
      }
      if (!params.journal) {
        arms.push({
          id,
          skillNames: [],
          contextBlock: null,
          note: "event journal unavailable; evidence traces cannot be rendered",
        });
        continue;
      }
      for (const s of evolved) {
        const ctx = await buildIclContext({
          journal: params.journal,
          skillName: s.name,
          runIds: s.evidenceRunIds,
          ...(params.configDir ? { storeOpts: { configDir: params.configDir } } : {}),
          ...(params.fresh ? { fresh: true } : {}),
        });
        icl.push(ctx);
        if (!ctx.usable) {
          arms.push({
            id: `in-context:${s.name}`,
            skillNames: [],
            contextBlock: null,
            note: `${ctx.renderedRunIds.length}/${ctx.runIds.length} evidence runs reconstruct; control skipped`,
          });
          continue;
        }
        arms.push({
          id: `evolved:${s.name}`,
          skillNames: [s.name],
          contextBlock: null,
          note: null,
        });
        arms.push({
          id: `in-context:${s.name}`,
          skillNames: [],
          contextBlock: ctx.block,
          note: null,
        });
      }
    }
  }
  return { arms, icl };
}
