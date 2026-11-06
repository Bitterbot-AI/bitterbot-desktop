/**
 * Online experience study (pure core for online-run.ts): an agent starts cold
 * in each `<workspace>:<family>` cell, solves a stream of episodes, and gets
 * only accept/reject feedback after each one. What it carries forward is the
 * arm's memory, rendered into the next episode of the same cell. Retrieval is
 * held fixed (same cell, all prior episodes); only the FORMAT of experience
 * differs between arms.
 */

import { createHash } from "node:crypto";
import { type SkillEvidence, verbalRecord } from "../../src/agents/skills/skill-prior.js";
import { mulberry32 } from "./tasks.js";

export { verbalRecord } from "../../src/agents/skills/skill-prior.js";

export const ONLINE_ARMS = [
  "none",
  "lessons",
  "episodes",
  "records",
  "records-index",
  "records-lessons",
  "bandit",
] as const;

/**
 * Confirmation study arms (registered after the first study): the first
 * study's leading formats on fresh seeds, plus two arms that split what the
 * episode log carries. `records-verbal` states the same counts in words
 * ("not tried yet", "rejected every time"); `episodes-noanswer` drops the
 * answer text, so it carries exactly the skill and verdict sequence.
 */
export const CONFIRM_ARMS = [
  "none",
  "records",
  "records-verbal",
  "records-index",
  "episodes",
  "episodes-noanswer",
] as const;
export type OnlineArm = (typeof ONLINE_ARMS)[number] | (typeof CONFIRM_ARMS)[number];

/** What one finished episode leaves behind in its cell. */
export interface EpisodeTrace {
  episode: number;
  /** Variant skill credited with the outcome (see creditedSkill), or null if none was read. */
  skill: string | null;
  /** All variant skills read, in order. */
  read: string[];
  final: string | null;
  accepted: boolean;
  /** Free-text lesson written after the verdict (lessons arms only). */
  lesson?: string;
}

/**
 * Credit rule (pre-registered): the outcome goes to the LAST variant skill
 * read before answering, the one the answer most plausibly followed. The
 * runtime cannot see which convention an answer matches, so neither may the
 * harness.
 */
export function creditedSkill(read: readonly string[], variants: readonly string[]): string | null {
  for (let i = read.length - 1; i >= 0; i--) {
    if (variants.includes(read[i]!)) {
      return read[i]!;
    }
  }
  return null;
}

/** Outcome counts per variant from this cell's history. */
export function recordsFrom(
  traces: readonly EpisodeTrace[],
  variants: readonly string[],
): Record<string, SkillEvidence> {
  const out: Record<string, SkillEvidence> = {};
  for (const v of variants) {
    out[v] = { passed: 0, runs: 0 };
  }
  for (const t of traces) {
    if (t.skill && out[t.skill]) {
      out[t.skill]!.runs += 1;
      out[t.skill]!.passed += t.accepted ? 1 : 0;
    }
  }
  return out;
}

const HEADER = "Notes from your earlier tasks of this kind in this workspace";

/** The memory block prepended to the task prompt (null = nothing to show). */
export function renderMemory(
  arm: OnlineArm,
  traces: readonly EpisodeTrace[],
  variants: readonly string[],
): string | null {
  if (traces.length === 0 || arm === "none" || arm === "bandit" || arm === "records-index") {
    return null;
  }
  const lines: string[] = [];
  if (arm === "records" || arm === "records-lessons") {
    const rec = recordsFrom(traces, variants);
    lines.push("Outcome record per skill (accepted / runs):");
    for (const v of variants) {
      lines.push(`- ${v}: ${rec[v]!.passed} of ${rec[v]!.runs} accepted`);
    }
  }
  if (arm === "records-verbal") {
    const rec = recordsFrom(traces, variants);
    lines.push("Outcome record per skill:");
    for (const v of variants) {
      lines.push(`- ${v}: ${verbalRecord(rec[v]!)}`);
    }
  }
  if (arm === "episodes" || arm === "episodes-noanswer") {
    for (const t of traces) {
      const answer = arm === "episodes" ? ` answered ${t.final ?? "(nothing)"},` : "";
      lines.push(
        `- Task ${t.episode + 1}: used ${t.skill ?? "no skill"},${answer} ${t.accepted ? "ACCEPTED" : "REJECTED"}.`,
      );
    }
  }
  if (arm === "lessons" || arm === "records-lessons") {
    const ls = traces.filter((t) => t.lesson?.trim());
    if (ls.length) {
      if (lines.length) {
        lines.push("");
      }
      lines.push("Lessons you wrote after earlier tasks:");
      for (const t of ls) {
        lines.push(`- ${t.lesson!.trim().replace(/\s+/g, " ")}`);
      }
    }
  }
  return lines.length ? `${HEADER}:\n${lines.join("\n")}\n\n` : null;
}

/** Prompt for the lesson writer: same feedback the other arms get, nothing more. */
export function lessonPrompt(args: {
  task: string;
  read: readonly string[];
  final: string | null;
  accepted: boolean;
  previous: readonly string[];
}): string {
  return [
    "You just finished a task as a coding agent. Write ONE short lesson (at most two sentences) that will help you do the next task of this kind in this same workspace better. Be concrete about which skill to use or avoid and why.",
    "",
    `Task: ${args.task}`,
    `Skills you opened, in order: ${args.read.length ? args.read.join(", ") : "none"}`,
    `Your final answer: ${args.final ?? "(none)"}`,
    `Verdict from the workspace: ${args.accepted ? "ACCEPTED" : "REJECTED"} (no other feedback is available).`,
    args.previous.length
      ? `Your earlier lessons here:\n${args.previous.map((l) => `- ${l}`).join("\n")}`
      : "",
    "",
    "Reply with the lesson only.",
  ]
    .filter((x) => x !== "")
    .join("\n");
}

/** Seeded Beta(a, b) draw via two gamma draws (Marsaglia-Tsang; integer-friendly). */
function gamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    return gamma(shape + 1, rng) * rng() ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller normal
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** Thompson sampling over the variants with a Beta(1, 1) prior; deterministic per seed. */
export function thompsonPick(
  rec: Readonly<Record<string, SkillEvidence>>,
  variants: readonly string[],
  seed: string,
): string {
  const rng = mulberry32(createHash("sha256").update(seed).digest().readUInt32BE(0));
  let best = variants[0]!;
  let bestDraw = -1;
  for (const v of variants) {
    const e = rec[v] ?? { passed: 0, runs: 0 };
    const a = gamma(1 + e.passed, rng);
    const b = gamma(1 + e.runs - e.passed, rng);
    const draw = a / (a + b);
    if (draw > bestDraw) {
      bestDraw = draw;
      best = v;
    }
  }
  return best;
}

export interface CurvePoint {
  episode: number;
  n: number;
  pass: number;
}

/** Mean pass per episode index across cells. */
export function learningCurve(
  rows: ReadonlyArray<{ episode: number; pass: number }>,
): CurvePoint[] {
  const m = new Map<number, number[]>();
  for (const r of rows) {
    m.set(r.episode, [...(m.get(r.episode) ?? []), r.pass]);
  }
  return [...m.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([episode, xs]) => ({
      episode,
      n: xs.length,
      pass: xs.reduce((s, x) => s + x, 0) / xs.length,
    }));
}

/**
 * Per-cell score for the primary contrast: mean pass over episodes >= `from`
 * (episode 0 is cold for every arm, so it carries no signal about memory).
 */
export function cellScores(
  rows: ReadonlyArray<{ cell: string; episode: number; pass: number }>,
  from = 1,
): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (r.episode >= from) {
      acc.set(r.cell, [...(acc.get(r.cell) ?? []), r.pass]);
    }
  }
  return new Map([...acc].map(([c, xs]) => [c, xs.reduce((s, x) => s + x, 0) / xs.length]));
}

/**
 * Cumulative regret against an oracle that always uses the right variant and
 * passes at `oracle` (the family's right-forced pass rate from the truth table).
 */
export function cumulativeRegret(
  rows: ReadonlyArray<{ family: string; pass: number }>,
  oracle: Readonly<Record<string, number>>,
): number {
  return rows.reduce((s, r) => s + ((oracle[r.family] ?? 1) - r.pass), 0);
}

export interface SwitchStats {
  afterAccept: { n: number; stay: number };
  afterReject: { n: number; stay: number };
}

/**
 * Win-stay / lose-shift: for consecutive episodes of one cell, how often the
 * credited skill stays the same after an accepted vs a rejected episode.
 * `traces` are one cell's episodes in order.
 */
export function switchStats(cells: ReadonlyArray<readonly EpisodeTrace[]>): SwitchStats {
  const s: SwitchStats = { afterAccept: { n: 0, stay: 0 }, afterReject: { n: 0, stay: 0 } };
  for (const ts of cells) {
    for (let i = 1; i < ts.length; i++) {
      const b = ts[i - 1]!.accepted ? s.afterAccept : s.afterReject;
      b.n += 1;
      b.stay += ts[i]!.skill === ts[i - 1]!.skill ? 1 : 0;
    }
  }
  return s;
}
