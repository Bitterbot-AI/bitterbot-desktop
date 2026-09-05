/**
 * Run outcome evidence hierarchy (2026-09-05 harness review, B3).
 *
 * "Pass" used to collapse five very different situations into one label.
 * This module derives, programmatically and from the journal only, how much
 * evidence a run actually carries that it achieved its objective:
 *
 *   L0  executed        — the run reached a terminal event.
 *   L1  tools clean     — every tool call returned without a thrown or
 *                         body-level error and none is awaiting approval.
 *   L2  self-reported   — the agent called complete() on top of L1.
 *   L3  verified        — the long-horizon task tied to the run passed an
 *                         independent judge round (level 3 = executed
 *                         checks passed; a judge-only pass counts as L3
 *                         with `judgeOnly` noted).
 *   L4  human-confirmed — an explicit run-feedback entry says confirmed.
 *
 * Negatives are recorded separately: a rejected feedback entry, a failed
 * task verification, or a pending approval are evidence AGAINST success
 * regardless of the level reached. Consumers (labeler, skill-read credits)
 * weigh the level; nothing here asks a model anything.
 */

import type { EventJournal } from "../../infra/event-journal.js";
import type { RunFeedbackEntry } from "./run-feedback.js";
import type { ReconstructedTrace } from "./types.js";

export type OutcomeLevel = 0 | 1 | 2 | 3 | 4;

export interface TaskVerdictEvidence {
  verdict: "pass" | "fail" | "needs_more";
  /** TaskVerification.level (1..4) as journaled by task_judge. */
  level: number;
  checksPassed: number;
  checksTotal: number;
  judgeModel: string | null;
  runId: string | null;
  ts: number;
}

export interface RunOutcome {
  level: OutcomeLevel;
  /** Human-readable evidence supporting the level, strongest last. */
  evidence: string[];
  /** Evidence against success (each one blocks a "pass" label). */
  negatives: string[];
  taskVerdict: TaskVerdictEvidence | null;
  feedback: RunFeedbackEntry | null;
}

/**
 * Latest judge verdict journaled for the run's task. The task_judge tool
 * journals under `task:<id>` with `taskId` set, so a lookup by task id is the
 * only join; when the verdict names a `runId`, only a verdict for THIS run
 * (or a verdict with no run id, for tools invoked outside a run) counts.
 */
export function findTaskVerdict(
  journal: EventJournal,
  taskId: string,
  runId: string,
): TaskVerdictEvidence | null {
  const events = journal.query({ taskId, streams: ["task"], limit: 500 });
  let latest: TaskVerdictEvidence | null = null;
  for (const evt of events) {
    if (evt.data.phase !== "judged") {
      continue;
    }
    const verdict = evt.data.verdict;
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "needs_more") {
      continue;
    }
    const evRunId = typeof evt.data.runId === "string" ? evt.data.runId : null;
    if (evRunId && evRunId !== runId) {
      continue;
    }
    latest = {
      verdict,
      level: typeof evt.data.level === "number" ? evt.data.level : 2,
      checksPassed: typeof evt.data.checksPassed === "number" ? evt.data.checksPassed : 0,
      checksTotal: typeof evt.data.checksTotal === "number" ? evt.data.checksTotal : 0,
      judgeModel: typeof evt.data.judgeModel === "string" ? evt.data.judgeModel : null,
      runId: evRunId,
      ts: evt.ts,
    };
  }
  return latest;
}

/** Pure given its inputs; `deriveRunOutcome` gathers them from the journal. */
export function computeRunOutcome(
  trace: ReconstructedTrace,
  extras: { taskVerdict?: TaskVerdictEvidence | null; feedback?: RunFeedbackEntry | null } = {},
): RunOutcome {
  const evidence: string[] = [];
  const negatives: string[] = [];
  const taskVerdict = extras.taskVerdict ?? null;
  const feedback = extras.feedback ?? null;
  let level: OutcomeLevel = 0;

  if (!trace.isComplete) {
    negatives.push("run has no terminal event");
    return { level, evidence, negatives, taskVerdict, feedback };
  }
  evidence.push(
    trace.endedWithError ? "run ended with a lifecycle error" : "run reached a terminal event",
  );
  if (trace.endedWithError) {
    negatives.push(`lifecycle error${trace.errorText ? `: ${trace.errorText.slice(0, 80)}` : ""}`);
  }
  if (trace.toolPendingCount > 0) {
    negatives.push(`${trace.toolPendingCount} tool call(s) still awaiting approval (never ran)`);
  }
  const toolsClean =
    !trace.endedWithError && trace.toolErrorCount === 0 && trace.toolPendingCount === 0;
  if (toolsClean) {
    level = 1;
    evidence.push(
      trace.toolCallCount > 0
        ? `${trace.toolCallCount} tool call(s), none failed`
        : "no tool calls (answer-only turn)",
    );
  } else if (trace.toolErrorCount > 0) {
    negatives.push(`${trace.toolErrorCount} tool call(s) failed`);
  }
  if (trace.completedExplicitly) {
    if (toolsClean) {
      level = 2;
      evidence.push("agent called complete() (self-report)");
    } else {
      negatives.push("agent called complete() despite failed or pending tool calls");
    }
  }
  if (taskVerdict) {
    if (taskVerdict.verdict === "pass") {
      level = 3;
      evidence.push(
        taskVerdict.checksTotal > 0
          ? `task judge passed with ${taskVerdict.checksPassed}/${taskVerdict.checksTotal} executed checks (L${taskVerdict.level})`
          : `task judge passed on output alone (judge-only, L${taskVerdict.level})`,
      );
    } else {
      negatives.push(
        `task judge said ${taskVerdict.verdict}${taskVerdict.checksTotal > 0 ? ` (${taskVerdict.checksPassed}/${taskVerdict.checksTotal} checks passed)` : ""}`,
      );
    }
  }
  if (feedback) {
    if (feedback.verdict === "confirmed") {
      level = 4;
      evidence.push(`human confirmed the outcome (${feedback.by})`);
    } else {
      negatives.push(
        `human rejected the outcome (${feedback.by})${feedback.note ? `: ${feedback.note.slice(0, 80)}` : ""}`,
      );
    }
  }
  return { level, evidence, negatives, taskVerdict, feedback };
}

/** Gather task verdict + feedback for the trace and compute the outcome. */
export function deriveRunOutcome(
  trace: ReconstructedTrace,
  deps: { journal?: EventJournal | null; feedback?: Map<string, RunFeedbackEntry> | null },
): RunOutcome {
  const taskVerdict =
    deps.journal && trace.taskId ? findTaskVerdict(deps.journal, trace.taskId, trace.runId) : null;
  const feedback = deps.feedback?.get(trace.runId) ?? null;
  return computeRunOutcome(trace, { taskVerdict, feedback });
}

export function formatRunOutcome(outcome: RunOutcome): string {
  const lines = [`evidence-level: L${outcome.level}`];
  for (const e of outcome.evidence) {
    lines.push(`  + ${e}`);
  }
  for (const n of outcome.negatives) {
    lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
