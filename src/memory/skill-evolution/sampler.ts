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
 *   - Exclusions: incomplete runs, tool-less runs (nothing to learn),
 *     evolution's own sessions and probe/validation sessions (anti
 *     self-distillation — a loop must not learn from its own rollouts).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type { IterationSample, LabeledTrace, SamplerStats } from "./types.js";
import { resolveWikiDir } from "../../agents/skills/impact-trail.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isA2aTaskSessionKey } from "../../sessions/session-key-utils.js";
import { hashBucket } from "../skill-execution-selection.js";
import { type JudgeCallFn, labelTrace } from "./labeler.js";
import {
  formatTraceLog,
  listRunsSince,
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

function samplerStatePath(opts: SamplerStateOptions): string {
  return path.join(resolveWikiDir(opts), SAMPLER_STATE_FILENAME);
}

export async function readSamplerState(
  opts: SamplerStateOptions = {},
): Promise<{ cursorSeq: number; updatedAt: number }> {
  try {
    const raw = await fs.readFile(samplerStatePath(opts), "utf-8");
    const parsed = JSON.parse(raw) as { cursorSeq?: unknown; updatedAt?: unknown };
    return {
      cursorSeq:
        typeof parsed.cursorSeq === "number" && Number.isFinite(parsed.cursorSeq)
          ? parsed.cursorSeq
          : 0,
      updatedAt:
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
    };
  } catch {
    return { cursorSeq: 0, updatedAt: 0 };
  }
}

export async function readSamplerCursor(opts: SamplerStateOptions = {}): Promise<number> {
  return (await readSamplerState(opts)).cursorSeq;
}

export async function writeSamplerCursor(
  cursorSeq: number,
  opts: SamplerStateOptions = {},
): Promise<void> {
  const p = samplerStatePath(opts);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ cursorSeq, updatedAt: Date.now() }, null, 2), "utf-8");
}

export interface SampleIterationOptions {
  /** Journal seq to scan from (exclusive). Callers persist via writeSamplerCursor. */
  cursorSeq: number;
  /** Optional LLM judge for ambiguous traces. */
  judgeCall?: JudgeCallFn;
  /** Session-key substrings to exclude. Defaults to DEFAULT_EXCLUDED_SESSION_PATTERNS. */
  excludedSessionPatterns?: string[];
  /** Override examination cap (tests). */
  maxRunsExamined?: number;
}

/**
 * Sample one iteration's stratified trace budget. Read-only against the
 * journal; the caller advances the cursor with `writeSamplerCursor`
 * AFTER the iteration completes successfully (so a crashed iteration
 * re-examines the same window rather than dropping it).
 */
export async function sampleIteration(
  journal: EventJournal,
  opts: SampleIterationOptions,
): Promise<IterationSample> {
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
  };

  const runs = await listRunsSince(journal, {
    sinceSeq: opts.cursorSeq,
    maxRuns: opts.maxRunsExamined ?? MAX_RUNS_EXAMINED,
  });

  const fails: LabeledTrace[] = [];
  const passes: LabeledTrace[] = [];
  let nextCursorSeq = opts.cursorSeq;

  for (const run of runs) {
    if (fails.length >= MAX_FAILING_TRACES && passes.length >= MAX_PASSING_TRACES) {
      break;
    }
    stats.runsExamined += 1;
    if (isRunHeldOut(run.runId)) {
      stats.runsHeldOut += 1;
      nextCursorSeq = Math.max(nextCursorSeq, run.lastSeq);
      continue;
    }
    // Metadata pre-filters (zero blob inflation): tool-less runs have
    // nothing to learn from; marathon runs are interactive sessions, not
    // task executions. Neither is worth reconstructing.
    if (run.toolEvents === 0 || run.totalEvents > MAX_RECONSTRUCT_EVENTS) {
      stats.runsExcluded += 1;
      nextCursorSeq = Math.max(nextCursorSeq, run.lastSeq);
      continue;
    }
    const trace = await reconstructTrace(journal, run.runId, { skipMarathonRuns: true });
    if (!trace) {
      stats.runsExcluded += 1;
      nextCursorSeq = Math.max(nextCursorSeq, run.lastSeq);
      continue;
    }
    if (!trace.isComplete) {
      // Still running: its terminal event will land at a NEW journal seq
      // beyond our cursor, so the run resurfaces on a later scan. (A run
      // that never gets a terminal event — hard process crash — is dropped;
      // it could not be labeled anyway.)
      stats.runsIncomplete += 1;
      nextCursorSeq = Math.max(nextCursorSeq, trace.lastSeq);
      continue;
    }
    nextCursorSeq = Math.max(nextCursorSeq, trace.lastSeq);
    if (trace.toolCallCount === 0) {
      stats.runsExcluded += 1;
      continue;
    }
    const key = trace.sessionKey ?? "";
    if (excluded.some((pattern) => key.includes(pattern))) {
      stats.runsExcluded += 1;
      continue;
    }
    // PLAN-43 Phase 1 (R2): inbound A2A task runs are driven by a REMOTE
    // caller — prime tool-bearing sampler fodder, and exactly the traces
    // evolution must never learn from (their text would flow into wiki
    // pattern pages and the skill proposer). Key-shape check, not a
    // substring, so a session merely mentioning "a2a-task" is unaffected.
    if (isA2aTaskSessionKey(key)) {
      stats.runsExcluded += 1;
      continue;
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
      continue;
    }
    const target = label.label === "fail" ? fails : passes;
    const cap = label.label === "fail" ? MAX_FAILING_TRACES : MAX_PASSING_TRACES;
    if (target.length >= cap) {
      continue;
    }
    target.push({ trace, label, formattedLog: formatTraceLog(trace) });
  }

  stats.failsSelected = fails.length;
  stats.passesSelected = passes.length;
  const samples = [...fails, ...passes].slice(0, MAX_TRACES_PER_ITERATION);
  log.debug(
    `sampled ${samples.length} traces (${fails.length} fail / ${passes.length} pass) from ${stats.runsExamined} runs; cursor ${opts.cursorSeq} -> ${nextCursorSeq}`,
  );
  return { samples, nextCursorSeq, stats };
}
