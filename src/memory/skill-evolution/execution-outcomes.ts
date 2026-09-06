/**
 * PLAN-45 Phase 1.1: stamp grounded run outcomes onto tool-level execution
 * rows.
 *
 * The after_tool_call hook writes one `skill_executions` row per tool call
 * that matched a skill crystal, tagged `evidence='tool'` with the journal
 * `run_id` it happened in. That row proves a tool ran; it says nothing
 * about whether the user's task succeeded. This housekeeping step joins each
 * un-stamped row to its run in the event journal, reconstructs the run,
 * derives the L0-L4 outcome (task verdicts, human feedback) and the
 * calibrated heuristic label, and stamps `run_outcome_label` /
 * `run_outcome_level` on every row of that run. Determinate verdicts lift
 * `evidence` to run | task | human and move the crystal's steering reward;
 * env-fail / unknown stay tool-level and never count as competence.
 *
 * Cursor: `run_outcome_level IS NULL` (no state file). Runs still in flight
 * are left for the next pass; a run with no terminal after `pendingTtlMs`
 * is stamped `unknown` (the process died). Rows with no run id (written
 * before v64) are stamped `unattributable` once and never revisited.
 */

import type { DatabaseSync } from "node:sqlite";
import type { ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import type { EventJournal } from "../../infra/event-journal.js";
import type { RunFeedbackEntry } from "./run-feedback.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { makeYieldEvery } from "../event-loop.js";
import {
  type RunOutcomeLabel,
  restampExecutionRunOutcome,
  stampExecutionRunOutcome,
} from "../skill-execution-tracker.js";
import { labelHeuristic } from "./labeler.js";
import { deriveRunOutcome } from "./outcome.js";
import { readRunFeedback } from "./run-feedback.js";
import { MAX_RECONSTRUCT_EVENTS, reconstructTrace } from "./traces.js";

const log = createSubsystemLogger("skill-evolution/execution-outcomes");

export const DEFAULT_MAX_RUNS_PER_PASS = 200;
export const DEFAULT_PENDING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PENDING_ROW_LIMIT = 5_000;

export interface BackfillExecutionOutcomesResult {
  /** Rows stamped with a run outcome this pass. */
  stamped: number;
  /** Distinct runs stamped. */
  runs: number;
  /** Rows whose run has no terminal yet (left for the next pass). */
  pending: number;
  /** Pre-v64 rows with no run id, stamped `unattributable`. */
  unattributable: number;
  /** Rows re-stamped because human feedback (L4) arrived after the first stamp. */
  restamped: number;
  byLabel: Record<string, number>;
}

/** A run is one user turn; failover/compaction retries re-enter with the SAME run id and share its verdict. */

export async function backfillExecutionOutcomes(params: {
  journal: EventJournal | null;
  db: DatabaseSync;
  storeOpts?: ImpactTrailOptions;
  now?: number;
  maxRunsPerPass?: number;
  pendingTtlMs?: number;
}): Promise<BackfillExecutionOutcomesResult> {
  const now = params.now ?? Date.now();
  const result: BackfillExecutionOutcomesResult = {
    stamped: 0,
    runs: 0,
    pending: 0,
    unattributable: 0,
    restamped: 0,
    byLabel: {},
  };
  let rows: Array<{ id: string; run_id: string | null; started_at: number }>;
  try {
    rows = params.db
      .prepare(
        `SELECT id, run_id, started_at FROM skill_executions
          WHERE run_outcome_level IS NULL AND completed_at IS NOT NULL
          ORDER BY started_at ASC LIMIT ?`,
      )
      .all(PENDING_ROW_LIMIT) as typeof rows;
  } catch (err) {
    // Pre-v64 schema (no run_outcome_level column): nothing to do.
    log.debug(`execution outcome back-fill skipped: ${String(err)}`);
    return result;
  }
  const feedback = await readRunFeedback(params.storeOpts ?? {});
  if (rows.length > 0) {
    await stampPendingRows(params, rows, feedback, now, result);
  }
  // Human feedback (L4) recorded AFTER a run was stamped outranks the
  // stamp: re-stamp those runs and correct steering (adversarial H3). Runs
  // even when nothing is pending.
  try {
    const stampedBelowHuman = params.db
      .prepare(
        `SELECT run_id, MAX(run_outcome_at) AS at FROM skill_executions
          WHERE run_id IS NOT NULL AND run_outcome_level IS NOT NULL AND run_outcome_level < 4
          GROUP BY run_id`,
      )
      .all() as Array<{ run_id: string; at: number | null }>;
    for (const row of stampedBelowHuman) {
      const fb = feedback.get(row.run_id);
      if (!fb || (row.at !== null && fb.ts < row.at)) {
        continue;
      }
      const n = restampExecutionRunOutcome(params.db, row.run_id, {
        label: fb.verdict === "confirmed" ? "pass" : "fail",
        level: 4,
        at: now,
      });
      result.restamped += n;
    }
  } catch (err) {
    log.debug(`feedback re-stamp failed: ${String(err)}`);
  }
  if (result.stamped > 0 || result.unattributable > 0 || result.restamped > 0) {
    log.info(
      `execution outcomes: stamped ${result.stamped} row(s) over ${result.runs} run(s) ${JSON.stringify(result.byLabel)}; pending ${result.pending}; unattributable ${result.unattributable}; restamped ${result.restamped}`,
    );
  }
  return result;
}

async function stampPendingRows(
  params: {
    journal: EventJournal | null;
    db: DatabaseSync;
    maxRunsPerPass?: number;
    pendingTtlMs?: number;
  },
  rows: Array<{ id: string; run_id: string | null; started_at: number }>,
  feedback: Map<string, RunFeedbackEntry>,
  now: number,
  result: BackfillExecutionOutcomesResult,
): Promise<void> {
  const legacy = rows.filter((r) => !r.run_id);
  if (legacy.length > 0) {
    const stamp = params.db.prepare(
      `UPDATE skill_executions
          SET run_outcome_label = 'unattributable', run_outcome_level = 0, run_outcome_at = ?
        WHERE id = ? AND run_outcome_level IS NULL`,
    );
    for (const r of legacy) {
      stamp.run(now, r.id);
    }
    result.unattributable = legacy.length;
  }

  if (!params.journal) {
    // No journal on this node: rows keep waiting; nothing can ground them.
    result.pending = rows.length - legacy.length;
    return;
  }

  const byRun = new Map<string, number>();
  for (const r of rows) {
    if (r.run_id) {
      byRun.set(r.run_id, Math.min(byRun.get(r.run_id) ?? r.started_at, r.started_at));
    }
  }
  const runIds = [...byRun.keys()].slice(0, params.maxRunsPerPass ?? DEFAULT_MAX_RUNS_PER_PASS);
  const tick = makeYieldEvery(16);
  const ttl = params.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;

  const stamp = (runId: string, label: RunOutcomeLabel, level: number) => {
    const n = stampExecutionRunOutcome(params.db, runId, { label, level, at: now });
    if (n > 0) {
      result.stamped += n;
      result.runs += 1;
      result.byLabel[label] = (result.byLabel[label] ?? 0) + 1;
    }
  };

  for (const runId of runIds) {
    await tick();
    const firstStartedAt = byRun.get(runId) ?? now;
    try {
      if (params.journal.countForRun(runId) > MAX_RECONSTRUCT_EVENTS) {
        stamp(runId, "unknown", 0);
        continue;
      }
      const trace = await reconstructTrace(params.journal, runId);
      if (!trace || !trace.isComplete) {
        if (now - firstStartedAt > ttl) {
          stamp(runId, "unknown", 0);
        } else {
          result.pending += 1;
        }
        continue;
      }
      trace.outcome = deriveRunOutcome(trace, { journal: params.journal, feedback });
      const label = labelHeuristic(trace);
      stamp(runId, label.label, trace.outcome.level);
    } catch (err) {
      log.debug(`execution outcome back-fill failed for run ${runId}: ${String(err)}`);
      result.pending += 1;
    }
  }
  if (byRun.size > runIds.length) {
    result.pending += byRun.size - runIds.length;
  }
}
