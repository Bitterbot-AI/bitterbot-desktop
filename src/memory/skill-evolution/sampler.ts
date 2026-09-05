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
 *     re-examined next iteration instead of being lost.
 *   - A bounded ring of examined run ids prevents a run that straddles the
 *     horizon from being sampled twice.
 *
 * PLAN-44 Phase 1 diversity (audit: one live iteration spent all five
 * failure slots on identical heartbeat curls):
 *   - `env-fail` traces never take a failure slot (they go to the corpus
 *     miner when human-authored).
 *   - A trace with the same task text AND tool-sequence shape as an
 *     already-selected trace is skipped (heartbeat monoculture).
 *   - Oldest-first within the 14-day window (recency comes from the
 *     fast-forward floor; reordering would pin the cursor).
 *   - Selected traces that ran the same task text with opposite outcomes
 *     are marked as a contrastive pair.
 */

import { createHash } from "node:crypto";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import type { EventJournal } from "../../infra/event-journal.js";
import type {
  IterationSample,
  LabeledTrace,
  PendingRun,
  ReconstructedTrace,
  SamplerStats,
  TraceToolStep,
} from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { isA2aTaskSessionKey } from "../../sessions/session-key-utils.js";
import { makeYieldEvery } from "../event-loop.js";
import { hashBucket } from "../skill-execution-selection.js";
import { type JudgeCallFn, labelTrace } from "./labeler.js";
import { deriveRunOutcome } from "./outcome.js";
import { readRunFeedback } from "./run-feedback.js";
import { classifyRunOrigin, isLearnableOrigin } from "./run-origin.js";
import { PENDING_MAX, PROCESSED_RING_MAX } from "./sampler-state.js";
import { classifyToolError } from "./signals.js";
import {
  formatTraceLog,
  listRunsSinceDetailed,
  MAX_RECONSTRUCT_EVENTS,
  reconstructTrace,
  runHasTerminal,
} from "./traces.js";

const log = createSubsystemLogger("skill-evolution/sampler");

// State I/O lives in sampler-state.ts; re-exported so callers keep one import.
export {
  MAX_PARSE_FAILURES,
  PENDING_MAX,
  PROCESSED_RING_MAX,
  readSamplerCursor,
  readSamplerState,
  type SamplerState,
  type SamplerStateOptions,
  writeSamplerCursor,
  writeSamplerState,
} from "./sampler-state.js";

/** Paper Appendix C budgets. */
export const MAX_TRACES_PER_ITERATION = 8;
export const MAX_FAILING_TRACES = 5;
export const MAX_PASSING_TRACES = 3;

/** Fraction of runs reserved (by run-id hash) for the validation gate. */
export const RUN_HELD_OUT_FRACTION = 0.2;

/** Runs examined per iteration before giving up on filling the budget. */
const MAX_RUNS_EXAMINED = 40;

/** PLAN-44 Phase 0: pending-list TTL (bounds live in sampler-state.ts). */
export const PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** PLAN-44 Phase 1: diversity bounds. */
export const MAX_ENV_FAIL_TEXTS = 3;

/**
 * Session-key patterns whose runs evolution must never learn from: its own
 * validation rollouts, doctor probes, and (defensively) anything tagged as
 * an evolution session. Substring match on sessionKey.
 */
export const DEFAULT_EXCLUDED_SESSION_PATTERNS = [
  ":probe-",
  "doctor-probe-",
  "skill-evolve",
  "cron:skill-evolve",
];

/** Deterministic: is this run reserved for validation (never sampled)? */
export function isRunHeldOut(runId: string): boolean {
  return hashBucket(runId) < Math.floor(RUN_HELD_OUT_FRACTION * 100);
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
  /** B8: where the run-feedback ledger lives (skill wiki dir); defaults to the config dir. */
  storeOpts?: ImpactTrailOptions;
}

/**
 * Tool-name sequence hash with the CLASS of every error: the trace's SHAPE.
 * Two runs of the same task that failed differently (exit code vs policy
 * block) are different lessons (adversarial M-8).
 */
export function toolSequenceHash(trace: ReconstructedTrace): string {
  const seq = trace.steps
    .filter((s): s is TraceToolStep => s.kind === "tool")
    .map((s) => (s.isError ? `${s.name}!${classifyToolError(s).cls}` : s.name))
    .join(">");
  return createHash("sha1").update(seq).digest("hex").slice(0, 12);
}

/**
 * Dedupe identity: the same TASK executed with the same SHAPE teaches the
 * same lesson (the audit's monoculture case: five identical heartbeat
 * curls). Different tasks that happen to share a shape ("one exec that
 * failed" is the most common live shape) are different lessons, so
 * without a task header there is no dedupe — the per-session cap still
 * applies.
 */
export function sampleDedupeKey(trace: ReconstructedTrace): string | null {
  const task = taskTextHash(trace);
  return task ? `${task}:${toolSequenceHash(trace)}` : null;
}

/** Task identity for contrastive pairing: strip the "[date] " prefix, whitespace, case. */
export function taskTextHash(trace: ReconstructedTrace): string | null {
  const text = trace.task?.text
    ?.replace(/^\s*\[[^\]]{0,60}\]\s*/, "")
    .trim()
    .toLowerCase();
  if (!text) {
    return null;
  }
  return createHash("sha1").update(text.replace(/\s+/g, " ")).digest("hex").slice(0, 12);
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
    envFails: 0,
    runsInjected: 0,
    runsDeduped: 0,
    pairs: 0,
    runsVerifiedOutcome: 0,
    runsPendingApproval: 0,
  };

  const fails: LabeledTrace[] = [];
  const passes: LabeledTrace[] = [];
  const envFailTexts: string[] = [];
  const failureSignatures: Record<string, number> = {};
  // B3/B8: human verdicts are read once per iteration and joined by run id.
  const feedback = await readRunFeedback(opts.storeOpts ?? {});
  const selectedShapes = new Set<string>();
  const budgetFull = () =>
    fails.length >= MAX_FAILING_TRACES && passes.length >= MAX_PASSING_TRACES;

  /**
   * Exclusions + labeling + selection for one COMPLETE, reconstructed trace.
   * "budget" = the trace was fine but its slot is full; the caller must NOT
   * count it as processed (it bounds the cursor and is sampled next time).
   */
  type AdmitOutcome = "selected" | "dropped" | "budget";
  const admit = async (trace: ReconstructedTrace): Promise<AdmitOutcome> => {
    if (trace.task) {
      stats.runsWithTask += 1;
    }
    if (trace.toolCallCount === 0) {
      stats.runsExcluded += 1;
      return "dropped";
    }
    if (trace.task?.isHeartbeat) {
      stats.runsHeartbeat += 1;
      stats.runsExcluded += 1;
      return "dropped";
    }
    // PLAN-44 (adversarial H1): a task text that reads as an instruction
    // override never reaches the maintainer, the judge, or the proposer.
    if (trace.task) {
      const scan = scanSkillForInjection(trace.task.text);
      if (scan.severity === "critical" || scan.severity === "medium") {
        stats.runsInjected += 1;
        stats.runsExcluded += 1;
        log.warn(
          `run ${trace.runId} excluded: task text flagged ${scan.severity} (${scan.reason})`,
        );
        return "dropped";
      }
    }
    const key = trace.sessionKey ?? "";
    // PLAN-44 Phase 0 (D-6): third-party-authored tasks never reach the
    // wiki or the proposer. Origin is derived from the session key at read
    // time (run-origin.ts), so pre-upgrade rows are covered too.
    const origin = trace.task?.origin ?? classifyRunOrigin(key);
    if (!isLearnableOrigin(origin)) {
      stats.runsUntrustedOrigin += 1;
      stats.runsExcluded += 1;
      return "dropped";
    }
    if (excluded.some((pattern) => key.includes(pattern))) {
      stats.runsExcluded += 1;
      return "dropped";
    }
    // PLAN-43 Phase 1 (R2): inbound A2A task runs are driven by a REMOTE
    // caller — prime tool-bearing sampler fodder, and exactly the traces
    // evolution must never learn from. Key-shape check, not a substring.
    if (isA2aTaskSessionKey(key)) {
      stats.runsExcluded += 1;
      return "dropped";
    }
    // PLAN-44 Phase 1: the dedupe gate runs BEFORE labeling (labeling may
    // call the judge; do not spend it on a trace we would drop anyway). No
    // per-session cap: on a real node most legitimate runs share the main
    // session key, so a cap would starve the sampler of exactly the traces
    // it should learn from; task+shape dedupe handles the monoculture case.
    const dedupeKey = sampleDedupeKey(trace);
    if (dedupeKey && selectedShapes.has(dedupeKey)) {
      stats.runsDeduped += 1;
      return "dropped";
    }
    const wantFail = fails.length < MAX_FAILING_TRACES;
    const wantPass = passes.length < MAX_PASSING_TRACES;
    // B3: join grounded evidence (task verdicts, human feedback) before
    // labeling so a verified outcome outranks the structural cascade.
    trace.outcome = deriveRunOutcome(trace, { journal, feedback });
    if (trace.toolPendingCount > 0) {
      stats.runsPendingApproval += 1;
    }
    const labelOpts = opts.judgeCall && (wantFail || wantPass) ? { judgeCall: opts.judgeCall } : {};
    const label = await labelTrace(trace, labelOpts);
    if (label.judged) {
      stats.judgeCalls += 1;
    }
    if ((label.evidenceLevel ?? 0) >= 3 || trace.outcome.feedback) {
      stats.runsVerifiedOutcome += 1;
    }
    if (label.label === "fail" && label.signature) {
      failureSignatures[label.signature.key] = (failureSignatures[label.signature.key] ?? 0) + 1;
    }
    if (label.label === "unknown") {
      stats.runsUnknownLabel += 1;
      return "dropped";
    }
    if (label.label === "env-fail") {
      // Not maintainer material. A human task that hit an outage is still
      // a real capability to draft a corpus task from.
      stats.envFails += 1;
      if (origin === "human" && envFailTexts.length < MAX_ENV_FAIL_TEXTS) {
        envFailTexts.push(formatTraceLog(trace));
      }
      return "dropped";
    }
    const target = label.label === "fail" ? fails : passes;
    const cap = label.label === "fail" ? MAX_FAILING_TRACES : MAX_PASSING_TRACES;
    if (target.length >= cap) {
      return "budget";
    }
    target.push({ trace, label, formattedLog: formatTraceLog(trace) });
    if (dedupeKey) {
      selectedShapes.add(dedupeKey);
    }
    return "selected";
  };

  const processedBefore = new Set(opts.processedRunIds ?? []);
  const processedOut: string[] = [];
  const pendingOut: PendingRun[] = [];

  // 1. Re-examine runs deferred as in-flight by earlier iterations. They
  //    do not move the cursor (their early events are already behind it).
  const pendingAll = opts.pending ?? [];
  const pendingIn = pendingAll
    .filter((p) => Math.abs(now - p.firstSeenAt) <= PENDING_TTL_MS)
    .slice(-PENDING_MAX);
  if (pendingIn.length < pendingAll.length) {
    log.info(
      `pending list: dropped ${pendingAll.length - pendingIn.length} expired/overflow run(s)`,
    );
  }
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
    if ((await admit(trace)) === "budget") {
      pendingOut.push(p); // slot full: keep it for next iteration
      continue;
    }
    processedOut.push(p.runId);
  }

  // 2. Scan forward from the cursor, OLDEST FIRST. Recency comes from the
  //    14-day fast-forward floor (evolution-pass.ts), not from reordering:
  //    examining newest-first would leave the oldest run unexamined every
  //    iteration and pin the cursor behind it. Runs left unexamined when
  //    the budget fills bound the cursor and are picked up next iteration.
  const scan = await listRunsSinceDetailed(journal, {
    sinceSeq: opts.cursorSeq,
    maxRuns: opts.maxRunsExamined ?? MAX_RUNS_EXAMINED,
    // Already-examined and pending runs do not consume the examination cap
    // (adversarial: a cap filled by processed straddlers stalled the scan).
    skipRunIds: new Set([...processedBefore, ...pendingIds]),
  });
  let maxProcessedLastSeq = opts.cursorSeq;
  for (const run of scan.skipped) {
    // Straddling a previous horizon, or handled via the pending list: the
    // cursor may pass their window-bounded events.
    maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
  }
  // Exclusive upper bound: the cursor must stay BELOW the first event of any
  // run this iteration did not examine.
  let bound = scan.deferredMinFirstSeq ?? Number.POSITIVE_INFINITY;

  const tick = makeYieldEvery(16);
  for (const run of scan.runs) {
    await tick(); // adversarial M-7: runHasTerminal is a sync sqlite read per tool-less run
    if (budgetFull()) {
      bound = Math.min(bound, run.firstSeq);
      continue;
    }
    stats.runsExamined += 1;
    if (isRunHeldOut(run.runId)) {
      // Never sampled; the cursor passes it. Not ringed (the ring is for
      // runs whose tail may straddle the horizon and get RE-SAMPLED;
      // held-out runs are refused by hash every time).
      stats.runsHeldOut += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    if (run.toolEvents === 0 && !runHasTerminal(journal, run)) {
      // Started, no tools yet, no terminal (truthful check: retried
      // attempts emit several `start`s): in flight. Defer, don't skip.
      pendingOut.push({ runId: run.runId, firstSeenAt: now });
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    // Metadata pre-filters (zero blob inflation): tool-less runs have
    // nothing to learn from; marathon runs are interactive sessions, not
    // task executions. Neither is worth reconstructing — nor ringing: a
    // tool-less run re-seen past the horizon is excluded again for free,
    // and ringing ~600 heartbeats per fortnight evicted the ids the ring
    // exists to protect (adversarial M1).
    if (run.toolEvents === 0 || run.totalEvents > MAX_RECONSTRUCT_EVENTS) {
      stats.runsExcluded += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    const trace = await reconstructTrace(journal, run.runId, { skipMarathonRuns: true });
    if (!trace) {
      stats.runsExcluded += 1;
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      processedOut.push(run.runId);
      continue;
    }
    if (!trace.isComplete) {
      stats.runsIncomplete += 1;
      pendingOut.push({ runId: run.runId, firstSeenAt: now });
      maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
      continue;
    }
    if ((await admit(trace)) === "budget") {
      // Slot full: not processed, and the cursor must not pass it.
      bound = Math.min(bound, run.firstSeq);
      continue;
    }
    // Cursor bookkeeping uses the SCAN-BOUNDED lastSeq, never the run's true
    // last event, so a run that ended past the horizon cannot drag the
    // cursor over runs interleaved with it.
    maxProcessedLastSeq = Math.max(maxProcessedLastSeq, run.lastSeq);
    processedOut.push(run.runId);
  }

  // No stall guard: if an unexamined run starts right after the cursor the
  // cursor simply holds, and oldest-first examination reaches that run
  // first next iteration (or defers it to pending if still in flight).
  const nextCursorSeq = Math.max(
    opts.cursorSeq,
    Math.min(maxProcessedLastSeq, scan.horizonSeq, bound - 1),
  );

  // PLAN-44 Phase 1: contrastive pairs — same task text, opposite outcome.
  const byTask = new Map<string, LabeledTrace[]>();
  for (const s of [...fails, ...passes]) {
    const h = taskTextHash(s.trace);
    if (h) {
      byTask.set(h, [...(byTask.get(h) ?? []), s]);
    }
  }
  for (const [h, group] of byTask) {
    if (
      group.some((s) => s.label.label === "fail") &&
      group.some((s) => s.label.label === "pass")
    ) {
      for (const s of group) {
        s.pairId = h;
      }
      stats.pairs += 1;
    }
  }

  stats.failsSelected = fails.length;
  stats.passesSelected = passes.length;
  const samples = [...fails, ...passes].slice(0, MAX_TRACES_PER_ITERATION);
  const processedRunIds = [...(opts.processedRunIds ?? []), ...processedOut].slice(
    -PROCESSED_RING_MAX,
  );
  log.debug(
    `sampled ${samples.length} traces (${fails.length} fail / ${passes.length} pass; ${stats.envFails} env-fail, ${stats.runsDeduped} deduped, ${stats.pairs} pairs) from ${stats.runsExamined} runs; cursor ${opts.cursorSeq} -> ${nextCursorSeq}; pending ${pendingOut.length}`,
  );
  return {
    samples,
    nextCursorSeq,
    stats,
    pending: pendingOut.slice(-PENDING_MAX),
    processedRunIds,
    envFailTexts,
    failureSignatures,
  };
}
