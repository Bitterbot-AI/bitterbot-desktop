/**
 * PLAN-42 Phase 4: "records" validation mode — score a candidate skill
 * against the incumbent over HELD-OUT reconstructed trajectories.
 *
 * This is the production stand-in for the paper's benchmark validation
 * split until the replayable task corpus ("tasks" mode) is reviewed and
 * enabled. Mechanism (ExperimentSandbox discipline, applied to SKILL.md):
 *
 *   1. Gather held-out runs (the 20% run-id partition the sampler NEVER
 *      touches), complete + tool-bearing, most recent first, cap 12.
 *   2. ONE batched LLM call: for each trial, judge whether the candidate
 *      skill text or the incumbent would more plausibly have led the agent
 *      to a better outcome on that trace. Scores in [0,1] per arm.
 *   3. Paired deltas -> exact one-sided sign test; ACCEPT iff p < 0.05
 *      with n >= MIN_PAIRED_TRIALS (strict gate, fidelity F7; the
 *      bootstrap CI is reported as a diagnostic only).
 *
 * Honest limitation, stated on the tin: this is an LLM-judged counterfactual
 * over past traces, not a rollout. It catches harmful and useless skills
 * cheaply; the "tasks" mode (real rollouts over the corpus) is the stronger
 * gate and takes over per skills.evolution.validationMode.
 */

import type { EventJournal } from "../../infra/event-journal.js";
import type { LlmCallFn } from "./maintainer.js";
import type { ReconstructedTrace } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isA2aTaskSessionKey } from "../../sessions/session-key-utils.js";
import { bootstrapMeanCi, MIN_PAIRED_TRIALS } from "./bootstrap-ci.js";
import { DEFAULT_EXCLUDED_SESSION_PATTERNS } from "./sampler.js";
import { isRunHeldOut } from "./sampler.js";
import { exactSignTest } from "./sign-test.js";

/** Judge score margin below which a pair is a tie (position-bias floor). */
export const RECORDS_MIN_DISCORDANT_DELTA = 0.1;
import {
  formatTraceLog,
  listRunsSince,
  MAX_RECONSTRUCT_EVENTS,
  reconstructTrace,
} from "./traces.js";

const log = createSubsystemLogger("skill-evolution/validate-records");

export const MAX_VALIDATION_TRIALS = 12;
const TRIAL_LOG_MAX_CHARS = 2_500;

export interface RecordsValidationVerdict {
  accepted: boolean;
  reason:
    | "accepted"
    | "insufficient-trials"
    | "no-improvement"
    | "scoring-parse-failed"
    | "llm-failed";
  meanDelta?: number;
  ci95Low?: number;
  ci95High?: number;
  trials: number;
}

/** Collect held-out validation traces (never seen by the maintainer/proposer). */
export async function collectHeldOutTraces(
  journal: EventJournal,
  opts: { maxTrials?: number } = {},
): Promise<ReconstructedTrace[]> {
  const maxTrials = opts.maxTrials ?? MAX_VALIDATION_TRIALS;
  // Scan the whole journal for held-out runs; cheap relative to LLM spend
  // and only runs when a proposal actually reached the gate.
  const runs = await listRunsSince(journal, { sinceSeq: 0, maxRuns: 400 });
  const heldOut = runs.filter(
    (r) => isRunHeldOut(r.runId) && r.toolEvents > 0 && r.totalEvents <= MAX_RECONSTRUCT_EVENTS,
  );
  const traces: ReconstructedTrace[] = [];
  // Most recent first: recent behavior is the distribution we validate for.
  for (const run of heldOut.toReversed()) {
    const trace = await reconstructTrace(journal, run.runId, { skipMarathonRuns: true });
    if (!trace || !trace.isComplete || trace.toolCallCount === 0) {
      continue;
    }
    // PLAN-43 R2: the validation prompt must never carry remote A2A caller
    // content or evolution's own rollouts — same exclusions the sampler
    // applies to maintainer/proposer fodder.
    const key = trace.sessionKey ?? "";
    if (
      isA2aTaskSessionKey(key) ||
      DEFAULT_EXCLUDED_SESSION_PATTERNS.some((pattern) => key.includes(pattern))
    ) {
      continue;
    }
    traces.push(trace);
    if (traces.length >= maxTrials) {
      break;
    }
  }
  return traces;
}

function buildScoringPrompt(params: {
  candidateName: string;
  candidateContent: string;
  incumbentContent: string | null;
  traces: ReconstructedTrace[];
}): string {
  const trials = params.traces
    .map(
      (t, i) =>
        `### Trial ${i + 1}\n\`\`\`\n${formatTraceLog(t, { maxChars: TRIAL_LOG_MAX_CHARS })}\n\`\`\``,
    )
    .join("\n\n");
  return `You are validating a proposed agent skill against real past execution traces.

## Candidate skill "${params.candidateName}" (VERSION B)
\`\`\`
${params.candidateContent.slice(0, 6_000)}
\`\`\`

## Incumbent (VERSION A)
${
  params.incumbentContent
    ? "```\n" + params.incumbentContent.slice(0, 6_000) + "\n```"
    : "(no such skill exists today — VERSION A is the agent acting without it)"
}

## Trials
Each trial below is a real execution trace. For each, judge: if the agent had
been operating under VERSION A vs VERSION B, how likely is a good outcome on
this kind of task? Score each version 0.0-1.0. Judge only what the skill text
would actually change; when the skill is irrelevant to the trial, give both
versions the same score.

${trials}

Respond with ONLY a JSON array, one entry per trial, in order:
[{"trial": 1, "a": 0.0, "b": 0.0}, ...]`;
}

function parseScores(raw: string, expected: number): Array<{ a: number; b: number }> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw)?.trim() ?? "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const scores: Array<{ a: number; b: number }> = [];
  for (const entry of parsed) {
    const e = entry as Record<string, unknown>;
    const a = typeof e?.a === "number" ? e.a : NaN;
    const b = typeof e?.b === "number" ? e.b : NaN;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || a > 1 || b < 0 || b > 1) {
      continue;
    }
    scores.push({ a, b });
  }
  return scores.length === expected ? scores : scores.length >= MIN_PAIRED_TRIALS ? scores : null;
}

/**
 * Validate candidate skill content vs the incumbent over held-out traces.
 * Strict acceptance: exact sign test p < 0.05 on the paired delta (b - a),
 * counting only pairs whose |delta| clears RECORDS_MIN_DISCORDANT_DELTA.
 */
export async function validateAgainstRecords(params: {
  journal: EventJournal;
  llmCall: LlmCallFn;
  candidateName: string;
  candidateContent: string;
  incumbentContent: string | null;
  maxTrials?: number;
}): Promise<RecordsValidationVerdict> {
  const traces = await collectHeldOutTraces(
    params.journal,
    params.maxTrials ? { maxTrials: params.maxTrials } : {},
  );
  if (traces.length < MIN_PAIRED_TRIALS) {
    return { accepted: false, reason: "insufficient-trials", trials: traces.length };
  }
  const prompt = buildScoringPrompt({
    candidateName: params.candidateName,
    candidateContent: params.candidateContent,
    incumbentContent: params.incumbentContent,
    traces,
  });
  let raw: string;
  try {
    raw = await params.llmCall(prompt);
  } catch (err) {
    log.warn(`validation scoring call failed: ${String(err)}`);
    return { accepted: false, reason: "llm-failed", trials: traces.length };
  }
  const scores = parseScores(raw, traces.length);
  if (!scores) {
    return { accepted: false, reason: "scoring-parse-failed", trials: traces.length };
  }
  const deltas = scores.map((s) => s.b - s.a);
  const ci = bootstrapMeanCi(deltas);
  // Corpus/gate upgrade 2026-09-02: exact sign test is the gate (correct
  // at small n, never degenerates); the bootstrap CI is reported only.
  // A judge's position bias (B always scored a hair above A) must not
  // count as evidence: a pair is discordant only above a minimum margin.
  const sign = exactSignTest(
    deltas.map((d) => (Math.abs(d) >= RECORDS_MIN_DISCORDANT_DELTA ? d : 0)),
  );
  const accepted = ci.n >= MIN_PAIRED_TRIALS && sign.pValue < 0.05;
  log.info(
    `records validation for "${params.candidateName}": n=${ci.n} meanDelta=${ci.meanDelta.toFixed(3)} ` +
      `wins=${sign.wins} losses=${sign.losses} p=${sign.pValue.toFixed(4)} ` +
      `ci95=[${ci.ci95Low.toFixed(3)}, ${ci.ci95High.toFixed(3)}] -> ${accepted ? "ACCEPT" : "REJECT"}`,
  );
  return {
    accepted,
    reason: accepted ? "accepted" : "no-improvement",
    meanDelta: ci.meanDelta,
    ci95Low: ci.ci95Low,
    ci95High: ci.ci95High,
    trials: ci.n,
  };
}
