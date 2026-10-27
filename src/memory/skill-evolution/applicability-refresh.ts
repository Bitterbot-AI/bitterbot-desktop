/**
 * PLAN-58 Phase B: rebuild `<skill>/.applicability.json` for every live skill
 * in the housekeeping pass, right after the evidence record, from the same
 * ledgers plus a bounded number of journal traces that credited a read.
 *
 * Runs in the housekeeping lane only; never on a user turn; no LLM calls.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import type { EventJournal } from "../../infra/event-journal.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  APPLICABILITY_MAX_TRACE_RUNS,
  APPLICABILITY_PROFILE_FILENAME,
  type ApplicabilityTraceInput,
  buildApplicabilityProfile,
  parseApplicabilityProfile,
  type SkillApplicabilityProfile,
} from "./applicability-profile.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { deriveRunOutcome } from "./outcome.js";
import { readRunFeedback } from "./run-feedback.js";
import { readSkillReadEvents, type SkillReadEvent } from "./skill-reads.js";
import { reconstructTrace } from "./traces.js";
import type { TraceLabel } from "./types.js";
import type { EvolutionMeta } from "./validation-gate.js";

const log = createSubsystemLogger("skill-evolution/applicability");

async function readLiveMeta(liveRoot: string, name: string): Promise<EvolutionMeta | null> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(liveRoot, name, ".evolution-meta.json"), "utf-8"),
    ) as EvolutionMeta;
  } catch {
    return null;
  }
}

async function readLiveSkillMd(liveRoot: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(liveRoot, name, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

function asLabel(v: string): TraceLabel {
  return v === "pass" || v === "fail" || v === "env-fail" ? v : "unknown";
}

/**
 * Reconstruct the newest credited runs for one skill (at most
 * APPLICABILITY_MAX_TRACE_RUNS) so the profile can describe their shape.
 * A journal that cannot serve a run yields nothing for it, never a throw.
 */
async function tracesFor(
  journal: EventJournal | null,
  events: SkillReadEvent[],
  name: string,
  since: number,
  opts: ImpactTrailOptions,
  max = APPLICABILITY_MAX_TRACE_RUNS,
): Promise<ApplicabilityTraceInput[]> {
  if (!journal) {
    return [];
  }
  const byRun = new Map<string, SkillReadEvent>();
  for (const e of events) {
    if (e.skill === name && e.credited && e.ts >= since && !byRun.has(e.runId)) {
      byRun.set(e.runId, e);
    }
  }
  const newest = [...byRun.values()].toSorted((a, b) => b.ts - a.ts).slice(0, max);
  let feedback: Awaited<ReturnType<typeof readRunFeedback>> | null = null;
  try {
    feedback = await readRunFeedback(opts);
  } catch {
    feedback = null;
  }
  const out: ApplicabilityTraceInput[] = [];
  for (const e of newest) {
    try {
      const trace = await reconstructTrace(journal, e.runId, { skipMarathonRuns: true });
      if (!trace) {
        continue;
      }
      const outcome = deriveRunOutcome(trace, { journal, feedback });
      out.push({ trace, label: asLabel(e.label), outcome });
    } catch {
      // One unreadable run never blocks the profile.
    }
  }
  return out;
}

export interface RefreshApplicabilityResult {
  written: number;
  skipped: number;
}

/**
 * Rebuild `.applicability.json` for every live skill directory. Only skills
 * the evolution loop governs or that carry read evidence get a profile;
 * bundled or workspace skills with no reads and no meta are skipped so the
 * pass stays cheap on a fresh node.
 */
export async function refreshApplicabilityProfiles(params: {
  storeOpts?: ImpactTrailOptions;
  journal: EventJournal | null;
  platform: string;
  now?: number;
  windowDays?: number;
}): Promise<RefreshApplicabilityResult> {
  const opts = params.storeOpts ?? {};
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let names: string[] = [];
  try {
    names = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9._-]*$/.test(d.name))
      .map((d) => d.name);
  } catch {
    return { written: 0, skipped: 0 };
  }
  const now = params.now ?? Date.now();
  const windowDays = params.windowDays;
  const since = now - (windowDays ?? 14) * 24 * 60 * 60 * 1000;
  const events = await readSkillReadEvents(opts);
  const result: RefreshApplicabilityResult = { written: 0, skipped: 0 };
  for (const name of names) {
    const meta = await readLiveMeta(roots.liveRoot, name);
    const hasReads = events.some((e) => e.skill === name && e.credited && e.ts >= since);
    if (!meta && !hasReads) {
      result.skipped += 1;
      continue;
    }
    try {
      const profile = buildApplicabilityProfile({
        name,
        events,
        meta,
        skillMd: await readLiveSkillMd(roots.liveRoot, name),
        traces: await tracesFor(params.journal, events, name, since, opts),
        platform: params.platform,
        now,
        ...(windowDays !== undefined ? { windowDays } : {}),
      });
      await atomicWriteJson(
        path.join(roots.liveRoot, name, APPLICABILITY_PROFILE_FILENAME),
        profile,
      );
      result.written += 1;
    } catch (err) {
      log.debug(`applicability profile for ${name} failed: ${String(err)}`);
      result.skipped += 1;
    }
  }
  return result;
}

/** Read one live skill's profile from disk (validated), or null. */
export async function readApplicabilityProfile(
  liveRoot: string,
  name: string,
): Promise<SkillApplicabilityProfile | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(liveRoot, name, APPLICABILITY_PROFILE_FILENAME), "utf-8"),
    ) as unknown;
    return parseApplicabilityProfile(raw);
  } catch {
    return null;
  }
}
