/**
 * PLAN-42 Phase 1: stratified trace sampling for one evolution iteration.
 *
 * Implements the paper's Appendix C budget: at most 8 traces per iteration,
 * stratified to at most 5 failing (root-cause material) and 3 passing
 * (regression-prevention material), each formatted log capped at 15k chars.
 * Production adaptations:
 *
 *   - Monotonic seq cursor (persisted under skill-wiki/.sampler-state.json)
 *     so iterations never rescan the same runs — the distillation lane's
 *     anti-rescan idiom.
 *   - Deterministic run-id held-out partition (SHA-1 bucket, same discipline
 *     as skill-execution-selection.ts): held-out runs are reserved for the
 *     validation gate and never fed to the Wiki Maintainer.
 *   - Exclusions: tool-less runs (nothing to learn), evolution's own
 *     sessions and probe/validation sessions (anti self-distillation — a
 *     loop must not learn from its own rollouts), and — PLAN-44 Phase 0 —
 *     heartbeat runs and third-party-origin runs (circle, A2A, subagent,
 *     guest), decided from the journaled task header / session key.
 *
 * PLAN-44 Phase 0 cursor semantics (audit findings):
 *   - The cursor never passes the scan horizon and never passes the first
 *     event of a run the scan saw but this iteration did not examine
 *     (interleaved runs were being skipped forever).
 *   - In-flight runs are DEFERRED to a bounded `pending` list and
 *     re-examined next iteration instead of being lost (the old comment
 *     claimed they "resurface"; they were excluded as tool-less).
 *   - A bounded ring of examined run ids prevents a run that straddles the
 *     horizon from being sampled twice.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type {
  IterationSample,
  LabeledTrace,
  PendingRun,
  ReconstructedTrace,
  SamplerStats,
} from "./types.js";
import { resolveWikiDir } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isA2aTaskSessionKey } from "../../sessions/session-key-utils.js";
import { hashBucket } from "../skill-execution-selection.js";
import { atomicWriteJson } from "./fs-atomic.js";
import { type JudgeCallFn, labelTrace } from "./labeler.js";
import { classifyRunOrigin, isLearnableOrigin } from "./run-origin.js";
import {
  formatTraceLog,
  listRunsSinceDetailed,
  MAX_RECONSTRUCT_EVENTS,
  reconstructTrace,
} from "./traces.js";

const log = createSubsystemLogger("skill-evolution/sampler");

/** Paper Appendix C budgets. */
export const MAX_TRACES_PER_ITERATION = 8;
export const MAX_FAILING_TRACES = 5;
export const MAX_PASSING_TRACES = 3;

/** Fraction of runs reserved (by run-id hash) for the validation gate. */
export const RUN_HELD_OUT_FRACTION = 0.2;

/** Runs examined per iteration before giving up on filling the budget. */
const MAX_RUNS_EXAMINED = 40;

/** PLAN-44 Phase 0: pending-list bounds. */
export const PENDING_MAX = 50;
export const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
/** PLAN-44 Phase 0: anti-rescan ring of examined run ids. */
export const PROCESSED_RING_MAX = 200;

const SAMPLER_STATE_FILENAME = ".sampler-state.json";

/**
 * Session-key patterns whose runs evolution must never learn from: its own
 * validation rollouts, doctor probes, and (defensively) anything tagged as
 * an evolution session. Substring match on sessionKey.
 */
export const DEFAULT_EXCLUDED_SESSION_PATTERNS = [":probe-", "skill-evolve", "cron:skill-evolve"];

/** Deterministic: is this run reserved for validation (never sampled)? */
export function isRunHeldOut(runId: string): boolean {
  return hashBucket(runId) < Math.floor(RUN_HELD_OUT_FRACTION * 100);
}

export interface SamplerStateOptions {
  /** Defaults to CONFIG_DIR (state lives beside the wiki). Tests override. */
  configDir?: string;
}

export interface SamplerState {
  cursorSeq: number;
  updatedAt: number;
  /** PLAN-44 Phase 0: in-flight runs awaiting a terminal event. */
  pending: PendingRun[];
  /** PLAN-44 Phase 0: recently examined run ids (anti-rescan). */
  processed: string[];
}

function samplerStatePath(opts: SamplerStateOptions): string {
  return path.join(resolveWikiDir(opts), SAMPLER_STATE_FILENAME);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function readSamplerState(opts: SamplerStateOptions = {}): Promise<SamplerState> {
  try {
    const raw = await fs.readFile(samplerStatePath(opts), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pending = Array.isArray(parsed.pending)
      ? parsed.pending
          .filter(
            (p): p is { runId: string; firstSeenAt: number } =>
              !!p &&
              typeof p === "object" &&
              typeof (p as { runId?: unknown }).runId === "string" &&
              typeof (p as { firstSeenAt?: unknown }).firstSeenAt === "number",
          )
          .map((p) => ({ runId: p.runId, firstSeenAt: p.firstSeenAt }))
      : [];
    const processed = Array.isArray(parsed.processed)
      ? parsed.processed.filter((p): p is string => typeof p === "string")
      : [];
    return {
      cursorSeq: num(parsed.cursorSeq),
      updatedAt: num(parsed.updatedAt),
      pending: pending.slice(-PENDING_MAX),
      processed: processed.slice(-PROCESSED_RING_MAX),
    };
  } catch {
    return { cursorSeq: 0, updatedAt: 0, pending: [], processed: [] };
  }
}

export async function readSamplerCursor(opts: SamplerStateOptions = {}): Promise<number> {
  return (await readSamplerState(opts)).cursorSeq;
}

/** Atomic; stamps updatedAt (the dream engine's cadence gate reads it). */
export async function writeSamplerState(
  state: Omit<SamplerState, "updatedAt">,
  opts: SamplerStateOptions = {},
): Promise<void> {
  await atomicWriteJson(samplerStatePath(opts), {
    cursorSeq: state.cursorSeq,
    updatedAt: Date.now(),
    pending: state.pending.slice(-PENDING_MAX),
    processed: state.processed.slice(-PROCESSED_RING_MAX),
  });
}

/** Cursor-only update that PRESERVES the pending list and processed ring. */
export async function writeSamplerCursor(
  cursorSeq: number,
  opts: SamplerStateOptions = {},
): Promise<void> {
  const prev = await readSamplerState(opts);
  await writeSamplerState({ cursorSeq, pending: prev.pending, processed: prev.processed }, opts);
}

export interface SampleIterationOptions {
  /** Journal seq to scan from (exclusive). Callers persist via writeSamplerState. */
  cursorSeq: number;
  /** Optional LLM judge for ambiguous traces. */
  judgeCall?: JudgeCallFn;
  /** Session-key substrings to exclude. Defaults to DEFAULT_EXCLUDED_SESSION_PATTERNS. */
  excludedSessionPatterns?: string[];
  /** Override examination cap (tests). */
  maxRunsExamined?: number;
  /** PLAN-44 Phase 0: in-flight runs deferred by the previous iteration. */
  pending?: PendingRun[];
  /** PLAN-44 Phase 0: run ids examined by recent iterations (skipped on rescan). */
  processedRunIds?: string[];
  /** Clock override (tests). */
  now?: number;
}

/**
 * Sample one iteration's stratified trace budget. Read-only against the
 * journal; the caller persists `nextCursorSeq` / `pending` / `processedRunIds`
 * with `writeSamplerState` AFTER the iteration completes successfully (so a
 * crashed iteration re-examines the same window rather than dropping it).
 */
export async function sampleIteration(
  journal: EventJournal,
  opts: SampleIterationOptions,
): Promise<IterationSample> {
  const now = opts.now ?? Date.now();
  const excluded = opts.excludedSessionPatterns ?? DEFAULT_EXCLUDED_SESSION_PATTERNS;
  const stats: SamplerStats = {
    runsExamined: 0,
    runsIncomplete: 0,
    runsExcluded: 0,
    runsHeldOut: 0,
    runsUnknownLabel: 0,
    failsSelected: 0,
    passesSelected: 0,
    judgeCalls: 0,
    runsHeartbeat: 0,
    runsUntrustedOrigin: 0,
    pendingReexamined: 0,
    runsWithTask: 0,
  };

  const fails: LabeledTrace[] = [];
  const passes: LabeledTrace[] = [];
  const budgetFull = () =>
    fails.length >= MAX_FAILING_TRACES && passes.length >= MAX_PASSING_TRACES;

  /** Exclusions + labeling + selection for one COMPLETE, reconstructed trace. */
  const admit = async (trace: ReconstructedTrace): Promise<void> => {
    if (trace.task) {
      stats.runsWithTask += 1;
    }
    if (trace.toolCallCount === 0) {
      stats.runsExcluded += 1;
      return;
    }
    if (trace.task?.isHeartbeat) {
      stats.runsHeartbeat += 1;
      stats.runsExcluded += 1;
      return;
    }
    const key = trace.sessionKey ?? "";
    // PLAN-44 Phase 0 (D-6): third-party-authored tasks never reach the
    // wiki or the proposer. Origin is derived from the session key at read
    // time (run-origin.ts), so pre-upgrade rows are covered too.
    const origin = trace.task?.origin ?? classifyRunOrigin(key);
    if (!isLearnableOrigin(origin)) {
      stats.runsUntrustedOrigin += 1;
      stats.runsExcluded += 1;
      return;
    }
    if (excluded.some((pattern) => key.includes(pattern))) {
      stats.runsExcluded += 1;
      return;
    }
    // PLAN-43 Phase 1 (R2): inbound A2A task runs are driven by a REMOTE
    // caller — prime tool-bearing sampler fodder, and exactly the traces
    // evolution must never learn from. Key-shape check, not a substring.
    if (isA2aTaskSessionKey(key)) {
      stats.runsExcluded += 1;
      return;
    }
    const wantFail = fails.length < MAX_FAILING_TRACES;
    const wantPass = passes.length < MAX_PASSING_TRACES;
    const labelOpts = opts.judgeCall && (wantFail || wantPass) ? { judgeCall: opts.judgeCall } : {};
    const label = await labelTrace(trace, labelOpts);
    if (label.judged) {
      stats.judgeCalls += 1;
    }
    if (label.label === "unknown") {
      stats.runsUnknownLabel += 1;
      return;
    }
    const target = label.label === "fail" ? fails : passes;
    const cap = label.label === "fail" ? MAX_FAILING_TRACES : MAX_PASSING_TRACES;
    if (target.length >= cap) {
      return;
    }
    target.push({ trace, label, formattedLog: formatTraceLog(trace) });
  };

  const processedBefore = new Set(opts.processedRunIds ?? []);
  const processedOut: string[] = [];
  const pendingOut: PendingRun[] = [];

  // 1. Re-examine runs deferred as in-flight by earlier iterations. They
  //    do not move the cursor (their early events are already behind it).
  const pendingIn = (opts.pending ?? [])
    .filter((p) => now - p.firstSeenAt <= PENDING_TTL_MS)
    .slice(-PENDING_MAX);
  const pendingIds = new Set(pendingIn.map((p) => p.runId));
  for (const p of pendingIn) {
    if (budgetFull()) {
      pendingOut.push(p);
      continue;
    }
    const trace = await reconstructTrace(journal, p.runId, { skipMarathonRuns: true });
    if (!trace) {
      continue; // vanished / marathon — drop
    }
    stats.pendingReexamined += 1;
    if (!trace.isComplete) {
      pendingOut.push(p);
      continue;
    }
    stats.runsExamined += 1;
    processedOut.push(p.runId);
    await admit(trace);
  }

  // 2. Scan forward from the cursor.
  const scan = await listRunsSinceDetailed(journal, {
    sinceSeq: opts.cursorSeq,
    maxRuns: opts.maxRunsExamined ?? MAX_RUNS_EXAMINED,
  });
  let maxProcessedLastSeq = opts.cursorSeq;
  // Exclusive upper bound: the cursor must stay BELOW the first event of any
  // run this iteration did not examine.
  let bound = scan.deferredMinFirstSeq ?? Number.POSITIVE_INFINITY;

  for (const run of scan.runs) {
    if (budgetFull()) {
      bound = Math.min(bound, run.firstSeq);
      continue;
    }
    if (processedBefore.has(run.runId) || pendingIds.has(run.runId)) {
      // Straddling a previous horizon, or handled via the pending list.
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    stats.runsExamined += 1;
    if (isRunHeldOut(run.runId)) {
      stats.runsHeldOut += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      processedOut.push(run.runId);
      continue;
    }
    if (run.toolEvents === 0 && !run.hasTerminal) {
      // Started, no tools yet, no terminal: in flight. Defer, don't skip.
      pendingOut.push({ runId: run.runId, firstSeenAt: now });
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    // Metadata pre-filters (zero blob inflation): tool-less runs have
    // nothing to learn from; marathon runs are interactive sessions, not
    // task executions. Neither is worth reconstructing.
    if (run.toolEvents === 0 || run.totalEvents > MAX_RECONSTRUCT_EVENTS) {
      stats.runsExcluded += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      processedOut.push(run.runId);
      continue;
    }
    const trace = await reconstructTrace(journal, run.runId, { skipMarathonRuns: true });
    if (!trace) {
      stats.runsExcluded += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      processedOut.push(run.runId);
      continue;
    }
    // Cursor bookkeeping uses the SCAN-BOUNDED lastSeq, never the run's true
    // last event, so a run that ended past the horizon cannot drag the
    // cursor over runs interleaved with it.
    maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
    if (!trace.isComplete) {
      stats.runsIncomplete += 1;
      pendingOut.push({ runId: run.runId, firstSeenAt: now });
      continue;
    }
    processedOut.push(run.runId);
    await admit(trace);
  }

  let next = Math.min(maxProcessedLastSeq, scan.horizonSeq);
  if (bound - 1 > opts.cursorSeq) {
    next = Math.min(next, bound - 1);
  }
  const nextCursorSeq = Math.max(opts.cursorSeq, next);

  stats.failsSelected = fails.length;
  stats.passesSelected = passes.length;
  const samples = [...fails, ...passes].slice(0, MAX_TRACES_PER_ITERATION);
  const processedRunIds = [...(opts.processedRunIds ?? []), ...processedOut].slice(
    -PROCESSED_RING_MAX,
  );
  log.debug(
    `sampled ${samples.length} traces (${fails.length} fail / ${passes.length} pass) from ${stats.runsExamined} runs; cursor ${opts.cursorSeq} -> ${nextCursorSeq}; pending ${pendingOut.length}`,
  );
  return {
    samples,
    nextCursorSeq,
    stats,
    pending: pendingOut.slice(-PENDING_MAX),
    processedRunIds,
  };
}
