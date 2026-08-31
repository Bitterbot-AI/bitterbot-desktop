/**
 * PLAN-42 Phase 5: evolution status snapshot — one call that tells an
 * operator (gateway RPC, doctor, UI) exactly where the flywheel stands.
 * Read-only; every field is derived from disk state.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type ImpactTrailOptions, provenancePath } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { listP2pEligibleEvolvedSkills } from "./p2p-publish.js";
import { readSamplerState } from "./sampler.js";
import { loadTaskCorpus } from "./task-corpus.js";
import { listStagedEvolutionProposals, type EvolutionMeta } from "./validation-gate.js";
import { listPatternNames, logsPath, readIndex } from "./wiki-store.js";

export interface EvolutionStatus {
  wiki: {
    patternCount: number;
    indexPresent: boolean;
    lastLogAt: number | null;
  };
  sampler: { cursorSeq: number; updatedAt: number };
  stagedProposals: string[];
  evolvedLive: Array<{
    name: string;
    verdict: string | null;
    mode: string | null;
    validatedAt: number | null;
    publishedAt: number | null;
  }>;
  p2pEligible: string[];
  corpus: { present: boolean; version?: string; taskCount?: number };
  impactEntries: number;
}

export async function collectEvolutionStatus(
  opts: ImpactTrailOptions = {},
): Promise<EvolutionStatus> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  const patternNames = await listPatternNames(opts);
  let indexPresent = false;
  try {
    indexPresent = (await readIndex(opts)).trim().length > 0;
  } catch {
    indexPresent = false;
  }
  let lastLogAt: number | null = null;
  try {
    lastLogAt = (await fs.stat(logsPath(opts))).mtimeMs;
  } catch {
    lastLogAt = null;
  }
  const sampler = await readSamplerState(opts);
  const stagedProposals = await listStagedEvolutionProposals(roots);

  const evolvedLive: EvolutionStatus["evolvedLive"] = [];
  let liveEntries: string[] = [];
  try {
    liveEntries = await fs.readdir(roots.liveRoot);
  } catch {
    liveEntries = [];
  }
  for (const name of liveEntries) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      continue;
    }
    try {
      const raw = await fs.readFile(
        path.join(roots.liveRoot, name, ".evolution-meta.json"),
        "utf-8",
      );
      const meta = JSON.parse(raw) as EvolutionMeta & { published?: { at: number } };
      if (meta.origin !== "wiki-evolution") {
        continue;
      }
      evolvedLive.push({
        name,
        verdict: meta.validation?.verdict ?? null,
        mode: meta.validation?.mode ?? null,
        validatedAt: meta.validation?.validatedAt ?? null,
        publishedAt: meta.published?.at ?? null,
      });
    } catch {
      // not an evolved skill
    }
  }

  const eligible = await listP2pEligibleEvolvedSkills(opts);
  const corpus = await loadTaskCorpus(opts);
  let impactEntries = 0;
  try {
    const raw = await fs.readFile(provenancePath(opts), "utf-8");
    impactEntries = raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    impactEntries = 0;
  }

  return {
    wiki: { patternCount: patternNames.length, indexPresent, lastLogAt },
    sampler,
    stagedProposals,
    evolvedLive: evolvedLive.toSorted((a, b) => a.name.localeCompare(b.name)),
    p2pEligible: eligible.map((e) => e.name),
    corpus: corpus
      ? { present: true, version: corpus.version, taskCount: corpus.tasks.length }
      : { present: false },
    impactEntries,
  };
}
