/**
 * PLAN-44 Phase 5a: the USAGE SIGNAL. Did the agent open a live skill?
 *
 * Until this module existed the loop ended at "available": a promoted
 * SKILL.md appeared in the runtime index, but nothing recorded whether the
 * agent ever read it. The lifecycle store's usage counters had no runtime
 * caller and the execution tracker matches tool names to memory crystals,
 * not files. The only read detection lived inside the validation gate.
 *
 * This pass runs in housekeeping: it scans journal runs since a cursor,
 * finds `read` (or exec) tool calls whose path is a live skill's SKILL.md,
 * records one event per (run, skill) in `<wiki>/skill-reads.jsonl` with
 * the run's outcome, and credits the lifecycle store (usage / success
 * counts, last_used_at: the numbers the SICA regression gate already
 * reads). `summarizeSkillReads` folds the ledger into per-skill windowed
 * rates for status and, later, retirement (D-5).
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import { readCanaryRegistry } from "../../agents/skills/canary-registry.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import {
  liveSkillPath,
  resolveStorageRoots,
  type StorageRoots,
} from "../../agents/skills/skill-storage.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { makeYieldEvery } from "../event-loop.js";
import { SkillLifecycleStore } from "../skill-lifecycle.js";
import { appendCanaryRuns, type CanaryRunRow, isEligibleTask } from "./canary-ledger.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { labelHeuristic } from "./labeler.js";
import { deriveRunOutcome } from "./outcome.js";
import { readRunFeedback } from "./run-feedback.js";
import { classifyRunOrigin, isLearnableOrigin } from "./run-origin.js";
import { listRunsSinceDetailed, runHasTerminal } from "./run-scan.js";
import { DEFAULT_EXCLUDED_SESSION_PATTERNS } from "./sampler.js";
import { MAX_RECONSTRUCT_EVENTS, reconstructTrace } from "./traces.js";

const log = createSubsystemLogger("skill-evolution/skill-reads");

export const SKILL_READS_FILENAME = "skill-reads.jsonl";
export const SKILL_READS_STATE_FILENAME = "skill-reads-state.json";
/** Runs scanned per pass (a test may lower it to exercise the deferral path). */
export const DEFAULT_MAX_RUNS_PER_PASS = 500;
/** Incomplete runs remembered for a later pass. */
const MAX_PENDING = 200;
const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** (run, skill) keys remembered to keep the ledger append-only and idempotent. */
const MAX_SEEN = 4_000;

export interface SkillReadEvent {
  runId: string;
  skill: string;
  ts: number;
  /** B3: the run's label was `pass` (labeler cascade over the outcome hierarchy). */
  success: boolean;
  /** B3: pass | fail | env-fail | unknown; env-fail/unknown credit usage only, never a verdict. */
  label: string;
  /** B3: evidence level L0-L4 behind the label. */
  outcomeLevel: number;
  /** B2: exact model substrate (`provider/model`) or null for old runs. */
  model: string | null;
  /** The agent called complete() (a stronger success signal than `success`). */
  completedExplicitly: boolean;
  /** Tool errors in the run, so a consumer can refine `success`. */
  toolErrors: number;
  origin: string;
  sessionKey: string | null;
  /**
   * Whether the event fed the lifecycle counters. Only first-party (human /
   * system) non-heartbeat runs do (adversarial M3): a circle or A2A party
   * must not be able to inflate the numbers the regression gate reads.
   */
  credited: boolean;
}

interface SkillReadsState {
  cursorSeq: number;
  pending: Array<{ runId: string; firstSeq: number; seenAt: number }>;
  seen: string[];
}

export function skillReadsPath(opts: ImpactTrailOptions = {}): string {
  return path.join(resolveWikiDir(opts), SKILL_READS_FILENAME);
}
function statePath(opts: ImpactTrailOptions): string {
  return path.join(resolveWikiDir(opts), SKILL_READS_STATE_FILENAME);
}

async function readState(opts: ImpactTrailOptions): Promise<SkillReadsState> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(statePath(opts), "utf-8"),
    ) as Partial<SkillReadsState>;
    return {
      cursorSeq: typeof parsed.cursorSeq === "number" ? parsed.cursorSeq : 0,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen : [],
    };
  } catch {
    return { cursorSeq: 0, pending: [], seen: [] };
  }
}

/** Which live skills a run opened: `read` of `<liveRoot>/<name>/SKILL.md`, or an exec naming it. */
export function skillsReadInRun(
  journal: EventJournal,
  runId: string,
  roots: StorageRoots,
  liveNames: string[],
  workspaceDir?: string,
): string[] {
  const targets = new Map<string, string>();
  for (const name of liveNames) {
    targets.set(path.resolve(liveSkillPath(roots, name)), name);
  }
  if (targets.size === 0) {
    return [];
  }
  const rows = journal.query({ runId, streams: ["tool"], limit: 2_000 });
  const found = new Set<string>();
  for (const row of rows) {
    if (row.data.phase !== "start") {
      continue;
    }
    const args = (row.data.args ?? {}) as Record<string, unknown>;
    if (row.data.name === "read") {
      const raw = [args.path, args.file_path, args.filePath].find((v) => typeof v === "string") as
        | string
        | undefined;
      if (!raw) {
        continue;
      }
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const expanded = raw.startsWith("~/") && home ? path.join(home, raw.slice(2)) : raw;
      // Relative paths resolve against the workspace when known (the gate's
      // detectSkillRead does the same); a sandboxed session reads a COPY
      // under <sandbox>/skills and is not credited (documented limit).
      const resolved = path.isAbsolute(expanded)
        ? path.resolve(expanded)
        : workspaceDir
          ? path.resolve(workspaceDir, expanded)
          : null;
      const hit = resolved ? targets.get(resolved) : undefined;
      if (hit) {
        found.add(hit);
      }
      continue;
    }
    if (row.data.name === "exec" && typeof args.command === "string") {
      for (const [target, name] of targets) {
        if (args.command.includes(target)) {
          found.add(name);
        }
      }
    }
  }
  return [...found].toSorted();
}

/**
 * PLAN-45 Phase 3.2: the exposure record the run path journaled (stream
 * `skills`), or null when the run's index carried no canary.
 */
export function canaryExposureForRun(
  journal: EventJournal,
  runId: string,
): { exposed: string[]; withheld: string[] } | null {
  const rows = journal.query({ runId, streams: ["skills"], limit: 4 });
  for (const row of rows) {
    const exposed = Array.isArray(row.data.exposed)
      ? row.data.exposed.filter((x): x is string => typeof x === "string")
      : [];
    const withheld = Array.isArray(row.data.withheld)
      ? row.data.withheld.filter((x): x is string => typeof x === "string")
      : [];
    if (exposed.length > 0 || withheld.length > 0) {
      return { exposed, withheld };
    }
  }
  return null;
}

function isExcludedSession(sessionKey: string | null | undefined): boolean {
  if (!sessionKey) {
    return false;
  }
  return DEFAULT_EXCLUDED_SESSION_PATTERNS.some((p) => sessionKey.includes(p));
}

export interface CreditSkillReadsResult {
  scannedRuns: number;
  credited: number;
  events: SkillReadEvent[];
  cursorSeq: number;
  /** PLAN-45 Phase 3.2: (run, canary skill) rows appended to canary-runs.jsonl. */
  canaryRows: number;
}

/**
 * Scan new runs, record skill reads, credit the lifecycle store. Safe to
 * call every housekeeping pass: the cursor and a seen-set make it
 * idempotent; incomplete runs are retried until they end or expire.
 */
export async function creditSkillReads(params: {
  journal: EventJournal;
  db?: DatabaseSync | null;
  storeOpts?: ImpactTrailOptions;
  /** Resolves relative read paths (the agent's workspace). */
  workspaceDir?: string;
  now?: number;
  maxRunsPerPass?: number;
}): Promise<CreditSkillReadsResult> {
  const opts = params.storeOpts ?? {};
  const now = params.now ?? Date.now();
  const roots = resolveStorageRoots(opts.configDir ? { configDir: opts.configDir } : {});
  let liveNames: string[];
  try {
    liveNames = (await fs.readdir(roots.liveRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    liveNames = [];
  }
  const state = await readState(opts);
  const seen = new Set(state.seen);
  const livePending = state.pending.filter((p) => now - p.seenAt <= PENDING_TTL_MS);
  const scan = await listRunsSinceDetailed(params.journal, {
    sinceSeq: state.cursorSeq,
    maxRuns: params.maxRunsPerPass ?? DEFAULT_MAX_RUNS_PER_PASS,
    // Pending runs are re-checked by id below; keep them out of the cap.
    skipRunIds: new Set(livePending.map((p) => p.runId)),
  });
  const pending: SkillReadsState["pending"] = [];
  const events: SkillReadEvent[] = [];
  const canaryRows: CanaryRunRow[] = [];
  const yieldTick = makeYieldEvery(16);
  const feedback = await readRunFeedback(opts);
  // PLAN-45 Phase 3.2: runs whose index the canary filter touched are
  // labeled even with zero reads: they are the control cohort.
  const canaries = (await readCanaryRegistry(opts)).skills;
  const hasCanaries = Object.keys(canaries).length > 0;
  const decide = async (runId: string, firstSeq: number, complete: boolean) => {
    if (!complete) {
      if (pending.length < MAX_PENDING) {
        pending.push({ runId, firstSeq, seenAt: now });
      } else {
        log.warn(`skill reads: pending list full; dropping incomplete run ${runId}`);
      }
      return;
    }
    if (liveNames.length === 0) {
      return;
    }
    const read = skillsReadInRun(params.journal, runId, roots, liveNames, params.workspaceDir);
    const exposure = hasCanaries ? canaryExposureForRun(params.journal, runId) : null;
    if (read.length === 0 && !exposure) {
      return;
    }
    const trace = await reconstructTrace(params.journal, runId);
    if (!trace) {
      return;
    }
    if (isExcludedSession(trace.sessionKey)) {
      return; // validation rollouts and probes open skills by construction
    }
    const origin = trace.task?.origin ?? classifyRunOrigin(trace.sessionKey);
    // B3: credit the run's OUTCOME, not "no lifecycle error". The labeler
    // cascade (with task verdicts and human feedback joined) decides; an
    // env-fail or unknown run credits nothing either way.
    trace.outcome = deriveRunOutcome(trace, { journal: params.journal, feedback });
    const label = labelHeuristic(trace);
    const credited = isLearnableOrigin(origin) && !(trace.task?.isHeartbeat ?? false);
    const success = label.label === "pass";
    for (const skill of read) {
      const key = `${runId} ${skill}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      events.push({
        runId,
        skill,
        ts: trace.endedAt ?? trace.startedAt ?? now,
        success,
        label: label.label,
        outcomeLevel: trace.outcome.level,
        model: trace.model,
        completedExplicitly: trace.completedExplicitly,
        toolErrors: trace.toolErrorCount,
        origin,
        sessionKey: trace.sessionKey ?? null,
        credited,
      });
    }
    if (exposure) {
      for (const [skill, exposed] of [
        ...exposure.exposed.map((n) => [n, true] as const),
        ...exposure.withheld.map((n) => [n, false] as const),
      ]) {
        const entry = canaries[skill];
        if (!entry) {
          continue; // window already closed
        }
        const key = `canary ${runId} ${skill}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const wasRead = read.includes(skill);
        canaryRows.push({
          runId,
          skill,
          ts: trace.endedAt ?? trace.startedAt ?? now,
          exposed,
          read: wasRead,
          // Lexical on both sides (adversarial 3-2): a read must not
          // widen the treated cohort's denominator.
          eligible: isEligibleTask(entry.descriptionAtStart, trace.task?.text),
          label: label.label,
          outcomeLevel: trace.outcome.level,
          model: trace.model,
          origin,
          credited,
          sessionKey: trace.sessionKey ?? null,
        });
      }
    }
  };
  // Pending runs: completeness is the terminal lifecycle event, not a row
  // count (start,start from a retry is NOT complete — adversarial M2).
  for (const p of livePending) {
    await yieldTick();
    const trace = await reconstructTrace(params.journal, p.runId);
    await decide(p.runId, p.firstSeq, trace?.isComplete === true);
  }
  for (const run of scan.runs) {
    await yieldTick();
    // Same pre-filter as the sampler: no tools → nothing to read; marathon
    // runs are not worth inflating (adversarial M4).
    if (run.toolEvents === 0 || run.totalEvents > MAX_RECONSTRUCT_EVENTS) {
      continue;
    }
    await decide(run.runId, run.firstSeq, runHasTerminal(params.journal, run));
  }
  // Ledger and state land BEFORE the lifecycle credits (adversarial L7): a
  // crash between them can lose credits, never double them.
  if (events.length > 0) {
    const file = skillReadsPath(opts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
  }
  await appendCanaryRuns(canaryRows, opts);
  // Adversarial H1: runs the cap deferred are not skipped — the cursor stops
  // just before the earliest deferred run, exactly like the sampler.
  const bound = scan.deferredMinFirstSeq !== null ? scan.deferredMinFirstSeq - 1 : scan.horizonSeq;
  const nextCursor = Math.max(state.cursorSeq, Math.min(scan.horizonSeq, bound));
  const seenList = [...seen];
  await atomicWriteJson(statePath(opts), {
    cursorSeq: nextCursor,
    pending,
    seen: seenList.slice(Math.max(0, seenList.length - MAX_SEEN)),
  } satisfies SkillReadsState);
  const store = params.db ? new SkillLifecycleStore(params.db) : null;
  if (store) {
    for (const e of events) {
      if (!e.credited) {
        continue;
      }
      try {
        store.recordUsage({
          skillName: e.skill,
          success: e.success,
          timestamp: e.ts,
          // env-fail / unknown runs count as usage, never as a verdict.
          indeterminate: e.label !== "pass" && e.label !== "fail",
        });
      } catch (err) {
        log.debug(`lifecycle credit failed for ${e.skill}: ${String(err)}`);
      }
    }
  }
  if (events.length > 0) {
    log.info(
      `skill reads: credited ${events.length} read(s) across ${new Set(events.map((e) => e.runId)).size} run(s)`,
    );
  }
  return {
    scannedRuns: scan.runs.length,
    credited: events.length,
    events,
    cursorSeq: nextCursor,
    canaryRows: canaryRows.length,
  };
}

export interface SkillReadSummary {
  name: string;
  reads: number;
  successes: number;
  /** successes / reads over the window; null when no reads. */
  successRate: number | null;
  lastReadAt: number | null;
  /** Distinct runs that opened the skill. */
  runs: number;
}

/** PLAN-45 Phase 1.3: every event in the ledger (malformed lines skipped). */
export async function readSkillReadEvents(
  opts: ImpactTrailOptions = {},
): Promise<SkillReadEvent[]> {
  let raw = "";
  try {
    raw = await fs.readFile(skillReadsPath(opts), "utf-8");
  } catch {
    return [];
  }
  const out: SkillReadEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line) as SkillReadEvent);
    } catch {
      // skip
    }
  }
  return out;
}

/** Per-skill read counts over the last `windowDays` (default 14), for every name in `liveNames` plus any skill in the ledger. */
export async function summarizeSkillReads(params: {
  storeOpts?: ImpactTrailOptions;
  liveNames?: string[];
  windowDays?: number;
  now?: number;
  /** Count reads from third-party / heartbeat runs too (default: first-party only, like the credits). */
  includeThirdParty?: boolean;
}): Promise<SkillReadSummary[]> {
  const now = params.now ?? Date.now();
  const since = now - (params.windowDays ?? 14) * 24 * 60 * 60 * 1000;
  let raw = "";
  try {
    raw = await fs.readFile(skillReadsPath(params.storeOpts ?? {}), "utf-8");
  } catch {
    raw = "";
  }
  const acc = new Map<string, SkillReadSummary & { runIds: Set<string> }>();
  const ensure = (name: string) => {
    let s = acc.get(name);
    if (!s) {
      s = {
        name,
        reads: 0,
        successes: 0,
        successRate: null,
        lastReadAt: null,
        runs: 0,
        runIds: new Set(),
      };
      acc.set(name, s);
    }
    return s;
  };
  for (const name of params.liveNames ?? []) {
    ensure(name);
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let e: SkillReadEvent;
    try {
      e = JSON.parse(line) as SkillReadEvent;
    } catch {
      continue;
    }
    if (typeof e.ts !== "number" || e.ts < since || typeof e.skill !== "string") {
      continue;
    }
    if (!params.includeThirdParty && e.credited !== undefined && !e.credited) {
      continue;
    }
    const s = ensure(e.skill);
    s.reads += 1;
    if (e.success) {
      s.successes += 1;
    }
    s.lastReadAt = Math.max(s.lastReadAt ?? 0, e.ts);
    s.runIds.add(e.runId);
  }
  return [...acc.values()]
    .map(({ runIds, ...s }) => ({
      ...s,
      runs: runIds.size,
      successRate: s.reads > 0 ? s.successes / s.reads : null,
    }))
    .toSorted((a, b) => b.reads - a.reads || a.name.localeCompare(b.name));
}
