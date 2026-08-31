/**
 * PLAN-42 Phase 4: "tasks" validation mode — real rollouts over the
 * replayable corpus, incumbent arm vs candidate arm, paired binary scores,
 * strict bootstrap acceptance. This is the strongest local answer to "is
 * this skill actually better than what exists".
 *
 * The runner is INJECTED: `runTask(task, variant)` executes one corpus task
 * with either the incumbent skill set ("incumbent") or the candidate
 * installed ("candidate") and returns the agent's final answer text. The
 * live adapter realizes the candidate arm as a canary (provisional promote
 * -> run -> decide -> rollback on reject) — see validation-gate.ts. Tests
 * inject deterministic fakes.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { bootstrapMeanCi, MIN_PAIRED_TRIALS } from "./bootstrap-ci.js";
import { type CorpusTask, scoreTaskAnswer, type TaskCorpus } from "./task-corpus.js";

const log = createSubsystemLogger("skill-evolution/validate-tasks");

export type TaskVariant = "incumbent" | "candidate";

export type TaskRunnerFn = (task: CorpusTask, variant: TaskVariant) => Promise<string>;

export interface TasksValidationVerdict {
  accepted: boolean;
  reason: "accepted" | "insufficient-tasks" | "no-improvement" | "runner-failed";
  corpusVersion: string;
  incumbentPassRate?: number;
  candidatePassRate?: number;
  meanDelta?: number;
  ci95Low?: number;
  ci95High?: number;
  trials: number;
  perTask?: Array<{ id: string; incumbent: 0 | 1; candidate: 0 | 1 }>;
}

/**
 * Run the corpus under both arms and gate strictly. A runner failure on a
 * task scores that arm 0 for the task (a skill that makes the agent crash
 * must lose, not error out of the gate); a runner that fails on EVERY task
 * in an arm aborts with runner-failed instead of producing a fake verdict.
 */
export async function validateAgainstTasks(params: {
  corpus: TaskCorpus;
  runTask: TaskRunnerFn;
}): Promise<TasksValidationVerdict> {
  const { corpus, runTask } = params;
  if (corpus.tasks.length < MIN_PAIRED_TRIALS) {
    return {
      accepted: false,
      reason: "insufficient-tasks",
      corpusVersion: corpus.version,
      trials: corpus.tasks.length,
    };
  }
  const perTask: Array<{ id: string; incumbent: 0 | 1; candidate: 0 | 1 }> = [];
  let incumbentErrors = 0;
  let candidateErrors = 0;
  for (const task of corpus.tasks) {
    let incumbent: 0 | 1 = 0;
    let candidate: 0 | 1 = 0;
    try {
      incumbent = scoreTaskAnswer(task, await runTask(task, "incumbent"));
    } catch (err) {
      incumbentErrors += 1;
      log.debug(`incumbent arm failed on ${task.id}: ${String(err)}`);
    }
    try {
      candidate = scoreTaskAnswer(task, await runTask(task, "candidate"));
    } catch (err) {
      candidateErrors += 1;
      log.debug(`candidate arm failed on ${task.id}: ${String(err)}`);
    }
    perTask.push({ id: task.id, incumbent, candidate });
  }
  if (incumbentErrors >= corpus.tasks.length || candidateErrors >= corpus.tasks.length) {
    return {
      accepted: false,
      reason: "runner-failed",
      corpusVersion: corpus.version,
      trials: corpus.tasks.length,
      perTask,
    };
  }
  const deltas = perTask.map((t) => t.candidate - t.incumbent);
  const ci = bootstrapMeanCi(deltas);
  const incumbentPassRate = perTask.reduce((a, t) => a + t.incumbent, 0) / perTask.length;
  const candidatePassRate = perTask.reduce((a, t) => a + t.candidate, 0) / perTask.length;
  const accepted = ci.n >= MIN_PAIRED_TRIALS && ci.ci95Low > 0;
  log.info(
    `tasks validation (corpus ${corpus.version}): incumbent ${(incumbentPassRate * 100).toFixed(0)}% vs candidate ${(candidatePassRate * 100).toFixed(0)}% ` +
      `ci95=[${ci.ci95Low.toFixed(3)}, ${ci.ci95High.toFixed(3)}] -> ${accepted ? "ACCEPT" : "REJECT"}`,
  );
  return {
    accepted,
    reason: accepted ? "accepted" : "no-improvement",
    corpusVersion: corpus.version,
    incumbentPassRate,
    candidatePassRate,
    meanDelta: ci.meanDelta,
    ci95Low: ci.ci95Low,
    ci95High: ci.ci95High,
    trials: ci.n,
    perTask,
  };
}
