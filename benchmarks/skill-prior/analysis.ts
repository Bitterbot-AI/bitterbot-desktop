/**
 * Pure analysis for the skill prior test. Paired by task instance (same
 * seed, same family, same files) across arms; the gate's exact sign test and
 * paired bootstrap give the uncertainty; families are the strata.
 */

import { bootstrapMeanCi } from "../../src/memory/skill-evolution/bootstrap-ci.js";
import { exactSignTest } from "../../src/memory/skill-evolution/sign-test.js";
import type { TrialRecord } from "./executor.js";
import { poolByFamily } from "./pool.js";

export function correctSkillFor(family: string): string {
  return poolByFamily(family).correct.name;
}

export function readCorrect(r: TrialRecord): 0 | 1 {
  return r.read.includes(correctSkillFor(r.family)) ? 1 : 0;
}

export function readDecoy(r: TrialRecord): 0 | 1 {
  return r.read.includes(poolByFamily(r.family).decoy.name) ? 1 : 0;
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

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export interface ArmSummary {
  arm: string;
  trials: number;
  tasks: number;
  pass: number | null;
  readCorrect: number | null;
  readDecoy: number | null;
  readAny: number | null;
  tokensPerTrial: number | null;
  wallMsPerTrial: number | null;
  errors: number;
  byFamily: Record<string, { trials: number; pass: number | null; readCorrect: number | null }>;
}

export function summarizeArm(records: readonly TrialRecord[]): ArmSummary | null {
  const first = records[0];
  if (!first) {
    return null;
  }
  const fams = new Map<string, TrialRecord[]>();
  for (const r of records) {
    const list = fams.get(r.family) ?? [];
    list.push(r);
    fams.set(r.family, list);
  }
  const byFamily: ArmSummary["byFamily"] = {};
  for (const [fam, list] of fams) {
    byFamily[fam] = {
      trials: list.length,
      pass: mean(list.map((r) => r.pass)),
      readCorrect: mean(list.map(readCorrect)),
    };
  }
  return {
    arm: first.arm,
    trials: records.length,
    tasks: byTask(records).size,
    pass: mean(records.map((r) => r.pass)),
    readCorrect: mean(records.map(readCorrect)),
    readDecoy: mean(records.map(readDecoy)),
    readAny: mean(records.map((r) => (r.read.length > 0 ? 1 : 0))),
    tokensPerTrial: mean(records.map((r) => r.tokensIn + r.tokensOut)),
    wallMsPerTrial: mean(records.map((r) => r.wallMs)),
    errors: records.filter((r) => r.error !== null).length,
    byFamily,
  };
}

export interface PairedContrast {
  arm: string;
  baseline: string;
  metric: "pass" | "readCorrect";
  n: number;
  wins: number;
  losses: number;
  ties: number;
  pValue: number | null;
  meanDelta: number | null;
  ci95Low: number | null;
  ci95High: number | null;
  /** Per-family mean delta (the strata). */
  byFamily: Record<string, number | null>;
}

/** Paired per task instance: mean over trials in arm minus mean in baseline. */
export function pairedContrast(
  arm: readonly TrialRecord[],
  baseline: readonly TrialRecord[],
  metric: "pass" | "readCorrect",
): PairedContrast | null {
  const a = arm[0];
  const b = baseline[0];
  if (!a || !b) {
    return null;
  }
  const f = (r: TrialRecord) => (metric === "pass" ? r.pass : readCorrect(r));
  const at = byTask(arm);
  const bt = byTask(baseline);
  const deltas: number[] = [];
  const famDeltas = new Map<string, number[]>();
  for (const [taskId, list] of at) {
    const other = bt.get(taskId);
    if (!other) {
      continue;
    }
    const d = (mean(list.map(f)) ?? 0) - (mean(other.map(f)) ?? 0);
    deltas.push(d);
    const fam = list[0]!.family;
    const fd = famDeltas.get(fam) ?? [];
    fd.push(d);
    famDeltas.set(fam, fd);
  }
  const sign = exactSignTest(deltas);
  const ci = deltas.length ? bootstrapMeanCi(deltas) : null;
  const byFamily: Record<string, number | null> = {};
  for (const [fam, ds] of famDeltas) {
    byFamily[fam] = mean(ds);
  }
  return {
    arm: a.arm,
    baseline: b.arm,
    metric,
    n: deltas.length,
    wins: sign.wins,
    losses: sign.losses,
    ties: sign.ties,
    pValue: deltas.length ? sign.pValue : null,
    meanDelta: ci?.meanDelta ?? null,
    ci95Low: ci?.ci95Low ?? null,
    ci95High: ci?.ci95High ?? null,
    byFamily,
  };
}

/**
 * Phase 0b headroom from the forced-skill truth table: per family, pass rate
 * with no skill, with the correct skill alone, with the decoy alone; the
 * oracle (correct first, assuming it is read) minus the no-skill baseline is
 * the room a reranker has to work with; decoy harm is what mis-ordering
 * costs.
 */
export interface Headroom {
  byFamily: Record<
    string,
    {
      none: number | null;
      correct: number | null;
      decoy: number | null;
      headroom: number | null;
      decoyHarm: number | null;
    }
  >;
  overall: {
    none: number | null;
    correct: number | null;
    decoy: number | null;
    headroom: number | null;
    decoyHarm: number | null;
  };
  /** Skills ranked by marginal pass rate when forced (the A3 global ordering). */
  globalOrder: Array<{ skill: string; pass: number | null; trials: number }>;
}

export function headroom(records: readonly TrialRecord[]): Headroom {
  const fams = new Set(records.map((r) => r.family));
  const byFamily: Headroom["byFamily"] = {};
  const cell = (fam: string, arm: string) =>
    mean(records.filter((r) => r.family === fam && r.arm === arm).map((r) => r.pass));
  for (const fam of fams) {
    const none = cell(fam, "none");
    const correct = cell(fam, "correct");
    const decoy = cell(fam, "decoy");
    byFamily[fam] = {
      none,
      correct,
      decoy,
      headroom: correct !== null && none !== null ? correct - none : null,
      decoyHarm: none !== null && decoy !== null ? none - decoy : null,
    };
  }
  const all = (arm: string) => mean(records.filter((r) => r.arm === arm).map((r) => r.pass));
  const none = all("none");
  const correct = all("correct");
  const decoy = all("decoy");
  const bySkill = new Map<string, TrialRecord[]>();
  for (const r of records) {
    if (r.arm === "none") {
      continue;
    }
    const skill = r.indexOrder[0];
    if (!skill) {
      continue;
    }
    const list = bySkill.get(skill) ?? [];
    list.push(r);
    bySkill.set(skill, list);
  }
  const globalOrder = [...bySkill.entries()]
    .map(([skill, list]) => ({ skill, pass: mean(list.map((r) => r.pass)), trials: list.length }))
    .toSorted((x, y) => (y.pass ?? 0) - (x.pass ?? 0));
  return {
    byFamily,
    overall: {
      none,
      correct,
      decoy,
      headroom: correct !== null && none !== null ? correct - none : null,
      decoyHarm: none !== null && decoy !== null ? none - decoy : null,
    },
    globalOrder,
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const pp = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)} pp`);

export function renderArmTable(summaries: readonly ArmSummary[]): string {
  const lines = [
    "| Arm | Trials | Pass | Read correct | Read decoy | Read any | Tokens/trial | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const s of summaries) {
    lines.push(
      `| ${s.arm} | ${s.trials} | ${pct(s.pass)} | ${pct(s.readCorrect)} | ${pct(s.readDecoy)} | ${pct(s.readAny)} | ${s.tokensPerTrial === null ? "n/a" : Math.round(s.tokensPerTrial)} | ${s.errors} |`,
    );
  }
  return lines.join("\n");
}

export function renderContrasts(contrasts: readonly PairedContrast[]): string {
  const lines = [
    "| Contrast | Metric | n | Wins / losses / ties | Mean delta | 95% CI | Sign-test p |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const c of contrasts) {
    lines.push(
      `| ${c.arm} minus ${c.baseline} | ${c.metric} | ${c.n} | ${c.wins} / ${c.losses} / ${c.ties} | ${pp(c.meanDelta)} | [${pp(c.ci95Low)}, ${pp(c.ci95High)}] | ${c.pValue === null ? "n/a" : c.pValue.toFixed(3)} |`,
    );
  }
  return lines.join("\n");
}

export function renderHeadroom(h: Headroom): string {
  const lines = [
    "| Family | No skill | Correct forced | Decoy forced | Headroom | Decoy harm |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [fam, c] of Object.entries(h.byFamily).toSorted()) {
    lines.push(
      `| ${fam} | ${pct(c.none)} | ${pct(c.correct)} | ${pct(c.decoy)} | ${pp(c.headroom)} | ${pp(c.decoyHarm)} |`,
    );
  }
  lines.push(
    `| **all** | ${pct(h.overall.none)} | ${pct(h.overall.correct)} | ${pct(h.overall.decoy)} | ${pp(h.overall.headroom)} | ${pp(h.overall.decoyHarm)} |`,
  );
  return lines.join("\n");
}
