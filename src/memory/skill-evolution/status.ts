/**
 * PLAN-42 Phase 5: evolution status snapshot — one call that tells an
 * operator (gateway RPC, doctor, UI) exactly where the flywheel stands.
 * Read-only; every field is derived from disk state.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type ImpactTrailOptions, provenancePath } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { loadEffectiveCorpus } from "./canonical-corpus.js";
import { readEvidenceRecords, type SkillEvidenceRecord } from "./evidence-record.js";
import { type IterationRecord, readRecentIterations } from "./iteration-log.js";
import { listP2pEligibleEvolvedSkills } from "./p2p-publish.js";
import { readSamplerState } from "./sampler.js";
import { rankFailureSignatures } from "./signatures.js";
import { listStagedEvolutionProposals, type EvolutionMeta } from "./validation-gate.js";
import { listPatternNames, logsPath, readIndex } from "./wiki-store.js";

export interface EvolutionStatus {
  wiki: {
    patternCount: number;
    indexPresent: boolean;
    lastLogAt: number | null;
  };
  sampler: { cursorSeq: number; updatedAt: number; pending: number; processed: number };
  /** PLAN-44 Phase 0: newest-last slice of skill-wiki/iterations.jsonl. */
  recentIterations: IterationRecord[];
  stagedProposals: string[];
  evolvedLive: Array<{
    name: string;
    verdict: string | null;
    mode: string | null;
    validatedAt: number | null;
    publishedAt: number | null;
    /** PLAN-45 Phase 3: canary | stable | rolled-back | retired (null for pre-Phase-3 records). */
    ladder: string | null;
    canary: { startedAt: number; endedAt: number | null; reason: string } | null;
    modelDrift: { from: string; to: string; at: number } | null;
  }>;
  p2pEligible: string[];
  corpus: { present: boolean; version?: string; taskCount?: number };
  impactEntries: number;
  /**
   * B6: failure-signature clusters over the recent iterations, ranked by
   * count. `iterations` says how many of those iterations saw the cluster:
   * a one-off has 1, a recurring learnable pattern has several.
   */
  failureSignatures: Array<{ key: string; count: number; iterations: number }>;
  /** PLAN-45 Phase 1.3: the per-skill evidence records as last rebuilt by housekeeping. */
  evidence: SkillEvidenceRecord[];
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
  const samplerState = await readSamplerState(opts);
  const sampler = {
    cursorSeq: samplerState.cursorSeq,
    updatedAt: samplerState.updatedAt,
    pending: samplerState.pending.length,
    processed: samplerState.processed.length,
  };
  const recentIterations = await readRecentIterations(10, opts);
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
      const meta = JSON.parse(raw) as EvolutionMeta;
      if (meta.origin !== "wiki-evolution") {
        continue;
      }
      evolvedLive.push({
        name,
        verdict: meta.validation?.verdict ?? null,
        mode: meta.validation?.mode ?? null,
        validatedAt: meta.validation?.validatedAt ?? null,
        publishedAt: meta.published?.at ?? null,
        ladder: meta.ladder?.state ?? null,
        canary: meta.canary
          ? {
              startedAt: meta.canary.startedAt,
              endedAt: meta.canary.endedAt ?? null,
              reason: meta.canary.reason,
            }
          : null,
        modelDrift: meta.modelDrift ?? null,
      });
    } catch {
      // not an evolved skill
    }
  }

  const eligible = await listP2pEligibleEvolvedSkills(opts);
  // Report the corpus the gate actually validates on (canonical baseline +
  // grown corpus), so status never diverges from gate behavior.
  const corpus = await loadEffectiveCorpus(opts);
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
    recentIterations,
    stagedProposals,
    evolvedLive: evolvedLive.toSorted((a, b) => a.name.localeCompare(b.name)),
    p2pEligible: eligible.map((e) => e.name),
    corpus: corpus
      ? { present: true, version: corpus.version, taskCount: corpus.tasks.length }
      : { present: false },
    impactEntries,
    failureSignatures: rankFailureSignatures(recentIterations.map((r) => r.failureSignatures)),
    evidence: await readEvidenceRecords(opts),
  };
}
