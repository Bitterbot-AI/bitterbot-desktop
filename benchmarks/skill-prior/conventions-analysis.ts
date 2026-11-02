/**
 * Pure helpers for the latent-convention runner (conventions-run.ts):
 * verified records from forced training runs, the swapped-record control,
 * Holm adjustment and the family-cluster bootstrap.
 */

import { createHash } from "node:crypto";
import type { SkillEvidence } from "../../src/agents/skills/skill-prior.js";
import { readCorrect } from "./analysis.js";
import type { TrialRecord } from "./executor.js";
import { mulberry32 } from "./tasks.js";

export function shuffled<T>(xs: readonly T[], seed: string): T[] {
  const rng = mulberry32(createHash("sha256").update(seed).digest().readUInt32BE(0));
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Verified records per cell from the training phase: runs that read the forced skill. */
export function recordsFromTraining(
  train: readonly TrialRecord[],
): Record<string, Record<string, SkillEvidence>> {
  const out: Record<string, Record<string, SkillEvidence>> = {};
  for (const r of train) {
    const forced = r.indexOrder.length === 1 ? r.indexOrder[0]! : null;
    if (!forced || !r.cell || r.error !== null || !r.read.includes(forced)) {
      continue;
    }
    const cell = (out[r.cell] ??= {});
    const e = (cell[forced] ??= { passed: 0, runs: 0 });
    e.passed += r.pass;
    e.runs += 1;
  }
  return out;
}

/** The right variant and one seeded wrong variant exchange records. */
export function swapRecords(
  cell: Record<string, SkillEvidence>,
  correct: string,
  decoys: readonly string[],
  seed: string,
): Record<string, SkillEvidence> {
  const out = { ...cell };
  const victim = shuffled(decoys, seed)[0]!;
  const c = cell[correct];
  const d = cell[victim];
  delete out[correct];
  delete out[victim];
  if (d) {
    out[correct] = d;
  }
  if (c) {
    out[victim] = c;
  }
  return out;
}

/** Holm step-down adjustment; returns adjusted p in input order. */
export function holm(ps: readonly number[]): number[] {
  const idx = ps.map((p, i) => ({ p, i })).toSorted((a, b) => a.p - b.p);
  const adj = new Array<number>(ps.length);
  let running = 0;
  idx.forEach(({ p, i }, k) => {
    running = Math.max(running, Math.min(1, (ps.length - k) * p));
    adj[i] = running;
  });
  return adj;
}

/**
 * Two-stage cluster bootstrap of the paired mean delta: resample families,
 * then instances within each drawn family. Nine families is few clusters, so
 * this is the primary interval, not a normal-theory clustered SE.
 */
export function clusterBootstrapCi(
  deltasByFamily: ReadonlyMap<string, readonly number[]>,
  draws = 4000,
  seed = 7,
): { mean: number; lo: number; hi: number } | null {
  const fams = [...deltasByFamily.values()].filter((d) => d.length > 0);
  if (fams.length === 0) {
    return null;
  }
  const all = fams.flat();
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let b = 0; b < draws; b++) {
    let s = 0;
    let n = 0;
    for (let f = 0; f < fams.length; f++) {
      const fam = fams[Math.floor(rng() * fams.length)]!;
      for (let i = 0; i < fam.length; i++) {
        s += fam[Math.floor(rng() * fam.length)]!;
        n++;
      }
    }
    stats.push(s / n);
  }
  stats.sort((a, b) => a - b);
  return { mean, lo: stats[Math.floor(0.025 * draws)]!, hi: stats[Math.floor(0.975 * draws)]! };
}

export function deltasByFamily(
  arm: readonly TrialRecord[],
  base: readonly TrialRecord[],
  metric: "pass" | "readCorrect",
): Map<string, number[]> {
  const f = (r: TrialRecord) => (metric === "pass" ? r.pass : readCorrect(r));
  const avg = (rs: TrialRecord[]) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  const group = (rs: readonly TrialRecord[]) => {
    const m = new Map<string, TrialRecord[]>();
    for (const r of rs) {
      m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
    }
    return m;
  };
  const a = group(arm);
  const b = group(base);
  const out = new Map<string, number[]>();
  for (const [task, list] of a) {
    const other = b.get(task);
    if (other) {
      const fam = list[0]!.family;
      out.set(fam, [...(out.get(fam) ?? []), avg(list) - avg(other)]);
    }
  }
  return out;
}
