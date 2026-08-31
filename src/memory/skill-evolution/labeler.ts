/**
 * PLAN-42 Phase 1: pass/fail labeling for reconstructed traces.
 *
 * The paper assumes a ground-truth scoring function; production has none, so
 * labels come from a cascade — cheapest signal first, an LLM trajectory
 * judge only for traces that stay ambiguous AND were actually selected for
 * sampling. Rules ordered by trustworthiness:
 *
 *   1. lifecycle error            → fail (hard signal, free)
 *   2. terminal tool error        → fail (the run's last act failed)
 *   3. high tool-error density    → fail
 *   4. complete() + clean tail    → pass (explicit self-report, corroborated)
 *   5. clean end, zero errors     → pass (weaker)
 *   6. otherwise                  → unknown → optional judge call
 *
 * `computeReward`-style length heuristics are deliberately NOT used —
 * PLAN-40 banned them and nothing here may resurrect them. The judge's
 * verdict space is pass|fail|unknown; unknown traces are excluded from
 * sampling rather than guessed at. Calibrate the judge against the fixture
 * corpus before trusting it on live data (benchmarks/skill-evolution).
 */

import type { ReconstructedTrace, TraceLabelResult } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatTraceLog } from "./traces.js";

const log = createSubsystemLogger("skill-evolution/labeler");

/** Below this heuristic confidence, an available judge gets the final word. */
export const JUDGE_CONFIDENCE_THRESHOLD = 0.7;

/** Judge prompt log budget — cheaper than the full maintainer budget. */
const JUDGE_LOG_MAX_CHARS = 8_000;

export type JudgeCallFn = (prompt: string) => Promise<string>;

/** Rule cascade over the trace's structural signals. Pure. */
export function labelHeuristic(trace: ReconstructedTrace): TraceLabelResult {
  if (!trace.isComplete) {
    return { label: "unknown", confidence: 0, reason: "run has no terminal event", judged: false };
  }
  if (trace.endedWithError) {
    return { label: "fail", confidence: 0.95, reason: "lifecycle error", judged: false };
  }
  const lastTool = trace.steps.toReversed().find((s) => s.kind === "tool");
  if (lastTool && lastTool.kind === "tool" && lastTool.isError) {
    return {
      label: "fail",
      confidence: 0.75,
      reason: `terminal tool call failed (${lastTool.name})`,
      judged: false,
    };
  }
  if (trace.toolCallCount >= 2 && trace.toolErrorCount / trace.toolCallCount > 0.5) {
    return {
      label: "fail",
      confidence: 0.6,
      reason: `tool-error density ${trace.toolErrorCount}/${trace.toolCallCount}`,
      judged: false,
    };
  }
  if (trace.completedExplicitly && trace.toolErrorCount === 0) {
    return {
      label: "pass",
      confidence: 0.75,
      reason: "agent called complete() with zero tool errors",
      judged: false,
    };
  }
  if (trace.toolCallCount > 0 && trace.toolErrorCount === 0) {
    return {
      label: "pass",
      confidence: 0.55,
      reason: "clean end, zero tool errors",
      judged: false,
    };
  }
  return {
    label: "unknown",
    confidence: 0.3,
    reason: "no decisive structural signal",
    judged: false,
  };
}

const JUDGE_PROMPT_HEADER = `You are labeling an AI agent execution trace as pass or fail.

A trace is "pass" when the agent accomplished what the user or task asked:
tools succeeded, the final answer addresses the request, no unresolved
errors. A trace is "fail" when the agent hit errors it did not recover
from, looped without progress, or ended without delivering what was asked.
If you genuinely cannot tell, answer unknown.

Respond with EXACTLY one line in this form and nothing else:
verdict: pass|fail|unknown

Trace:
`;

function parseJudgeVerdict(raw: string): "pass" | "fail" | "unknown" | null {
  const match = raw.match(/verdict:\s*(pass|fail|unknown)/i);
  if (!match) {
    return null;
  }
  return (match[1] as string).toLowerCase() as "pass" | "fail" | "unknown";
}

/**
 * Label a trace: heuristic first, judge only when the heuristic is weak and
 * a judge call is available. Judge failures degrade to the heuristic result
 * rather than throwing — labeling must never break the evolution loop.
 */
export async function labelTrace(
  trace: ReconstructedTrace,
  opts: { judgeCall?: JudgeCallFn } = {},
): Promise<TraceLabelResult> {
  const heuristic = labelHeuristic(trace);
  if (heuristic.confidence >= JUDGE_CONFIDENCE_THRESHOLD || !opts.judgeCall) {
    return heuristic;
  }
  try {
    const prompt = `${JUDGE_PROMPT_HEADER}${formatTraceLog(trace, { maxChars: JUDGE_LOG_MAX_CHARS })}`;
    const raw = await opts.judgeCall(prompt);
    const verdict = parseJudgeVerdict(raw);
    if (!verdict) {
      log.debug(`judge returned unparseable verdict for ${trace.runId}; keeping heuristic`);
      return heuristic;
    }
    if (verdict === "unknown") {
      return { label: "unknown", confidence: 0.5, reason: "judge: unknown", judged: true };
    }
    return {
      label: verdict,
      confidence: 0.8,
      reason: `judge verdict (heuristic was ${heuristic.label}/${heuristic.confidence})`,
      judged: true,
    };
  } catch (err) {
    log.debug(`judge call failed for ${trace.runId}: ${String(err)}; keeping heuristic`);
    return heuristic;
  }
}
