/**
 * PLAN-45 5.1: per-trial records -> pass@1, pass^K, tokens, and paired
 * statistics against a baseline arm. Pure. Reuses the gate's exact sign
 * test and bootstrap CI unchanged so the report's numbers are the gate's.
 */

import type { ArmId, CorpusId, ModelId } from "./plan.js";
import { bootstrapMeanCi } from "../../../src/memory/skill-evolution/bootstrap-ci.js";
import { exactSignTest } from "../../../src/memory/skill-evolution/sign-test.js";

export interface TrialRecord {
  arm: ArmId;
  corpus: CorpusId;
  model: ModelId;
  taskId: string;
  suite: string;
  trialIndex: number;
  pass: 0 | 1;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  /** Whether a skill file was read in the trial (null when unobservable). */
  skillRead: boolean | null;
  /** Prompt tokens served from the provider cache (part of tokensIn). */
  cacheRead: number;
  error: string | null;
}

/** The gate's credit rule: a pass counts for the skill only when the skill was read (unobservable = neutral). */
export function creditedPass(r: TrialRecord): 0 | 1 {
  return r.pass === 1 && r.skillRead !== false ? 1 : 0;
}

export interface ArmStats {
  arm: ArmId;
  corpus: CorpusId;
  model: ModelId;
  tasks: number;
  trials: number;
  /** Mean pass over all trials. */
  passAt1: number | null;
  /** Fraction of tasks where every trial passed (tau-bench pass^K). */
  passPowK: number | null;
  k: number;
  tokens: number;
  wallMs: number;
  /** Trials that read a skill file, over trials where it was observable. */
  readRate: number | null;
  errors: number;
}

export interface PairedStats {
  arm: ArmId;
  baseline: ArmId;
  corpus: CorpusId;
  model: ModelId;
  n: number;
  wins: number;
  losses: number;
  ties: number;
  pValue: number | null;
  meanDelta: number | null;
  ci95Low: number | null;
  ci95High: number | null;
  /** (arm tokens / baseline tokens) - 1 over tasks measured in both. */
  tokenDelta: number | null;
  /** The same test on CREDITED passes (the gate's rule). */
  credited: {
    n: number;
    wins: number;
    losses: number;
    ties: number;
    pValue: number | null;
    meanDelta: number | null;
  };
}

function byTask(records: readonly TrialRecord[]): Map<string, TrialRecord[]> {
  const m = new Map<string, TrialRecord[]>();
  for (const r of records) {
    const list = m.get(r.taskId) ?? [];
    list.push(r);
    m.set(r.taskId, list);
  }
  return m;
}

export function armStats(records: readonly TrialRecord[], k: number): ArmStats | null {
  const first = records[0];
  if (!first) {
    return null;
  }
  const tasks = byTask(records);
  let fullPass = 0;
  for (const list of tasks.values()) {
    if (list.length >= k && list.slice(0, k).every((r) => r.pass === 1)) {
      fullPass += 1;
    }
  }
  const observable = records.filter((r) => typeof r.skillRead === "boolean");
  return {
    arm: first.arm,
    corpus: first.corpus,
    model: first.model,
    tasks: tasks.size,
    trials: records.length,
    passAt1: records.length > 0 ? records.reduce((s, r) => s + r.pass, 0) / records.length : null,
    passPowK: tasks.size > 0 ? fullPass / tasks.size : null,
    k,
    tokens: records.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0),
    wallMs: records.reduce((s, r) => s + r.wallMs, 0),
    readRate:
      observable.length > 0
        ? observable.filter((r) => r.skillRead === true).length / observable.length
        : null,
    errors: records.filter((r) => r.error !== null).length,
  };
}

/** Paired per-task pass-rate deltas: arm minus baseline, capability tasks only. */
export function pairedStats(
  arm: readonly TrialRecord[],
  baseline: readonly TrialRecord[],
): PairedStats | null {
  const a = arm[0];
  const b = baseline[0];
  if (!a || !b) {
    return null;
  }
  const at = byTask(arm.filter((r) => r.suite !== "regression"));
  const bt = byTask(baseline.filter((r) => r.suite !== "regression"));
  const deltas: number[] = [];
  const creditedDeltas: number[] = [];
  let armTok = 0;
  let baseTok = 0;
  for (const [taskId, list] of at) {
    const other = bt.get(taskId);
    if (!other) {
      continue;
    }
    const rate = (l: TrialRecord[], f: (r: TrialRecord) => number) =>
      l.reduce((s, r) => s + f(r), 0) / l.length;
    deltas.push(rate(list, (r) => r.pass) - rate(other, (r) => r.pass));
    creditedDeltas.push(rate(list, creditedPass) - rate(other, (r) => r.pass));
    armTok += list.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
    baseTok += other.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
  }
  const sign = exactSignTest(deltas);
  const ci = deltas.length > 0 ? bootstrapMeanCi(deltas) : null;
  const cs = exactSignTest(creditedDeltas);
  return {
    arm: a.arm,
    baseline: b.arm,
    corpus: a.corpus,
    model: a.model,
    n: deltas.length,
    wins: sign.wins,
    losses: sign.losses,
    ties: sign.ties,
    pValue: deltas.length > 0 ? sign.pValue : null,
    meanDelta: ci?.meanDelta ?? null,
    ci95Low: ci?.ci95Low ?? null,
    ci95High: ci?.ci95High ?? null,
    tokenDelta: baseTok > 0 ? armTok / baseTok - 1 : null,
    credited: {
      n: creditedDeltas.length,
      wins: cs.wins,
      losses: cs.losses,
      ties: cs.ties,
      pValue: creditedDeltas.length > 0 ? cs.pValue : null,
      meanDelta:
        creditedDeltas.length > 0
          ? creditedDeltas.reduce((s, d) => s + d, 0) / creditedDeltas.length
          : null,
    },
  };
}
