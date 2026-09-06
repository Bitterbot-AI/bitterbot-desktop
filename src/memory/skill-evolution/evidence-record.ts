/**
 * PLAN-45 Phase 1.3: one evidence record per live skill, one reader.
 *
 * Everything downstream that wants to know "how good is this skill" (status
 * RPC, Control UI, marketplace ranking, the publish trailer, attestation)
 * reads this record and nothing else. It is DERIVED: nothing writes to it
 * except this module, and it is rebuilt every housekeeping pass from the
 * sources that already exist:
 *
 *   - skill-reads.jsonl         reads credited from the journal, with the
 *                               run's label and evidence level (Phase 5a/B3)
 *   - skill_lifecycle           usage / success / error counters
 *   - .evolution-meta.json      gate verdict, statistics, corpus, model,
 *                               description repairs, publish marker
 *   - .provenance.jsonl         gate history for the lineage (ancestry and
 *                               rejected edits, the SkillOpt buffer)
 *
 * Phase 3 adds the lifecycle ladder state and the canary monitor summary to
 * the same record; Phase 2 adds pass^k and token deltas from the gate.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SkillLifecycleStore } from "../skill-lifecycle.js";
import type { EvolutionMeta } from "./validation-gate.js";
import { readProvenance, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { readSkillReadEvents, type SkillReadEvent } from "./skill-reads.js";

const log = createSubsystemLogger("skill-evolution/evidence-record");

export const EVIDENCE_RECORD_FILENAME = ".evidence.json";
export const EVIDENCE_RECORD_VERSION = 1;
const DEFAULT_WINDOW_DAYS = 14;
const MAX_GATE_HISTORY = 20;

export type SkillLifecycleLadder =
  | "staged"
  | "validated"
  | "canary"
  | "stable"
  | "rolled-back"
  | "retired"
  | "unmanaged";

export interface SkillEvidenceRecord {
  version: number;
  name: string;
  generatedAt: number;
  windowDays: number;
  /** Where the skill came from: evolution, harvest, peer, workspace, unknown. */
  origin: string;
  /** Phase 3 ladder; "unmanaged" for skills the evolution loop does not govern. */
  ladder: SkillLifecycleLadder;
  /** PLAN-45 Phase 3: when and why the ladder last moved. */
  ladderAt: number | null;
  ladderBy: string | null;
  /** The current or last canary window (null for unmanaged / never canaried). */
  canary: { startedAt: number; endedAt: number | null; reason: string } | null;
  modelDrift: { from: string; to: string; at: number } | null;
  reads: {
    /** Credited first-party reads in the window. */
    total: number;
    /** Distinct runs that opened the skill in the window. */
    runs: number;
    /** Reads whose run labeled pass / fail / indeterminate (env-fail, unknown). */
    pass: number;
    fail: number;
    indeterminate: number;
    /** pass / (pass + fail); null until a determinate read exists. */
    successRate: number | null;
    /** Highest evidence level seen among credited reads (0-4). */
    maxEvidenceLevel: number;
    lastReadAt: number | null;
  };
  lifetime: {
    usageCount: number;
    successCount: number;
    errorCount: number;
    lastUsedAt: number | null;
  };
  gate: {
    verdict: string | null;
    mode: string | null;
    pValue: number | null;
    wins: number | null;
    losses: number | null;
    trials: number | null;
    trialsPerTask: number | null;
    corpusVersion: string | null;
    /** Candidate SKILL.md read rate on capability / regression tasks (trigger precision). */
    candidateReadRate: { capability: number | null; regression: number | null } | null;
    tokens: { incumbent: number; candidate: number } | null;
    validatedAt: number | null;
  } | null;
  models: {
    /** Model the gate validated the skill under. */
    validatedOn: string[];
    /** Models that read the skill in the window (from the journal). */
    readBy: string[];
  };
  descriptionRepairs: number;
  publishedAt: number | null;
  /** Gate history for the lineage, newest last: the ancestry + rejected-edit buffer. */
  gateHistory: Array<{
    at: number;
    action: string;
    verdict: string;
    score: number | null;
    detail: string | null;
  }>;
}

async function readEvolutionMeta(
  liveRoot: string,
  name: string,
): Promise<(EvolutionMeta & { published?: { at: number } }) | null> {
  try {
    const raw = await fs.readFile(path.join(liveRoot, name, ".evolution-meta.json"), "utf-8");
    return JSON.parse(raw) as EvolutionMeta & { published?: { at: number } };
  } catch {
    return null;
  }
}

function ladderFor(meta: EvolutionMeta | null): SkillLifecycleLadder {
  if (!meta || meta.origin !== "wiki-evolution") {
    return "unmanaged";
  }
  // PLAN-45 Phase 3: the persisted ladder wins. A pre-Phase-3 record with
  // an accepted verdict and no ladder is "validated" (gate passed, never
  // canaried); the monitor does not govern it until re-promoted.
  if (meta.ladder?.state) {
    return meta.ladder.state;
  }
  return meta.validation?.verdict === "accepted" ? "validated" : "staged";
}

export function buildEvidenceRecord(params: {
  name: string;
  events: SkillReadEvent[];
  lifecycle: {
    usageCount: number;
    successCount: number;
    errorCount: number;
    lastUsedAt: number | null;
    origin?: string;
  } | null;
  meta: (EvolutionMeta & { published?: { at: number } }) | null;
  provenance: Array<Record<string, unknown>>;
  now?: number;
  windowDays?: number;
}): SkillEvidenceRecord {
  const now = params.now ?? Date.now();
  const windowDays = params.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = now - windowDays * 24 * 60 * 60 * 1000;
  const reads = {
    total: 0,
    runs: 0,
    pass: 0,
    fail: 0,
    indeterminate: 0,
    successRate: null as number | null,
    maxEvidenceLevel: 0,
    lastReadAt: null as number | null,
  };
  const runIds = new Set<string>();
  const readBy = new Set<string>();
  for (const e of params.events) {
    if (e.skill !== params.name || !e.credited || e.ts < since) {
      continue;
    }
    reads.total += 1;
    runIds.add(e.runId);
    if (e.label === "pass") {
      reads.pass += 1;
    } else if (e.label === "fail") {
      reads.fail += 1;
    } else {
      reads.indeterminate += 1;
    }
    reads.maxEvidenceLevel = Math.max(reads.maxEvidenceLevel, e.outcomeLevel ?? 0);
    reads.lastReadAt = Math.max(reads.lastReadAt ?? 0, e.ts);
    if (e.model) {
      readBy.add(e.model);
    }
  }
  reads.runs = runIds.size;
  reads.successRate = reads.pass + reads.fail > 0 ? reads.pass / (reads.pass + reads.fail) : null;

  const v = params.meta?.validation;
  // appendImpactEntry writes the time as `ts` (adversarial H2); accept the
  // ImpactEntry field name too for hand-built records.
  const entryTs = (p: Record<string, unknown>): number | null =>
    typeof p.ts === "number" ? p.ts : typeof p.timestamp === "number" ? p.timestamp : null;
  const gateHistory = params.provenance
    .filter((p) => p.skillName === params.name && entryTs(p) !== null)
    .map((p) => ({
      at: entryTs(p) as number,
      action: typeof p.action === "string" ? p.action : "",
      verdict: typeof p.verdict === "string" ? p.verdict : "",
      score: typeof p.score === "number" ? p.score : null,
      detail: typeof p.detail === "string" ? p.detail.slice(0, 300) : null,
    }))
    .toSorted((a, b) => a.at - b.at)
    .slice(-MAX_GATE_HISTORY);

  return {
    version: EVIDENCE_RECORD_VERSION,
    name: params.name,
    generatedAt: now,
    windowDays,
    origin: params.meta?.origin ?? params.lifecycle?.origin ?? "unknown",
    ladder: ladderFor(params.meta),
    reads,
    lifetime: {
      usageCount: params.lifecycle?.usageCount ?? 0,
      successCount: params.lifecycle?.successCount ?? 0,
      errorCount: params.lifecycle?.errorCount ?? 0,
      lastUsedAt: params.lifecycle?.lastUsedAt ?? null,
    },
    gate: v
      ? {
          verdict: v.verdict ?? null,
          mode: v.mode ?? null,
          pValue: typeof v.pValue === "number" ? v.pValue : null,
          wins: typeof v.wins === "number" ? v.wins : null,
          losses: typeof v.losses === "number" ? v.losses : null,
          trials: typeof v.trials === "number" ? v.trials : null,
          trialsPerTask: typeof v.trialsPerTask === "number" ? v.trialsPerTask : null,
          corpusVersion: v.corpusVersion ?? null,
          candidateReadRate: v.candidateReadRate ?? null,
          tokens: v.tokens ?? null,
          validatedAt: typeof v.validatedAt === "number" ? v.validatedAt : null,
        }
      : null,
    models: {
      validatedOn: v?.model ? [v.model] : [],
      readBy: [...readBy].toSorted(),
    },
    ladderAt: params.meta?.ladder?.at ?? null,
    ladderBy: params.meta?.ladder?.by ?? null,
    canary: params.meta?.canary
      ? {
          startedAt: params.meta.canary.startedAt,
          endedAt: params.meta.canary.endedAt ?? null,
          reason: params.meta.canary.reason,
        }
      : null,
    modelDrift: params.meta?.modelDrift ?? null,
    descriptionRepairs: params.meta?.descriptionRepairs ?? 0,
    publishedAt: params.meta?.published?.at ?? null,
    gateHistory,
  };
}

/**
 * Rebuild `.evidence.json` for every live skill directory. Returns the
 * records (also written to disk, atomically) so status can serve them
 * without a second read.
 */
export async function refreshEvidenceRecords(params: {
  storeOpts?: ImpactTrailOptions;
  lifecycleStore?: SkillLifecycleStore | null;
  now?: number;
  windowDays?: number;
}): Promise<SkillEvidenceRecord[]> {
  const opts = params.storeOpts ?? {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let names: string[] = [];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const [events, provenance] = await Promise.all([readSkillReadEvents(opts), readProvenance(opts)]);
  const out: SkillEvidenceRecord[] = [];
  for (const name of names) {
    const meta = await readEvolutionMeta(roots.liveRoot, name);
    const row = params.lifecycleStore?.get(name) ?? null;
    const record = buildEvidenceRecord({
      name,
      events,
      lifecycle: row
        ? {
            usageCount: row.usageCount,
            successCount: row.successCount,
            errorCount: row.errorCount,
            lastUsedAt: row.lastUsedAt,
            origin: row.origin,
          }
        : null,
      meta,
      provenance,
      ...(params.now !== undefined ? { now: params.now } : {}),
      ...(params.windowDays !== undefined ? { windowDays: params.windowDays } : {}),
    });
    try {
      await atomicWriteJson(path.join(roots.liveRoot, name, EVIDENCE_RECORD_FILENAME), record);
    } catch (err) {
      log.debug(`evidence record write failed for ${name}: ${String(err)}`);
    }
    out.push(record);
  }
  return out;
}

/** Read the records already on disk (no recomputation). */
export async function readEvidenceRecords(
  opts: ImpactTrailOptions = {},
): Promise<SkillEvidenceRecord[]> {
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let names: string[] = [];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const out: SkillEvidenceRecord[] = [];
  for (const name of names) {
    try {
      const raw = await fs.readFile(
        path.join(roots.liveRoot, name, EVIDENCE_RECORD_FILENAME),
        "utf-8",
      );
      out.push(JSON.parse(raw) as SkillEvidenceRecord);
    } catch {
      // no record yet
    }
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name));
}
