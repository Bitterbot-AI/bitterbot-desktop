/**
 * Experience-guided skill prior: an outcome-gated, context-cell bandit that
 * reorders the `<available_skills>` index before the model sees it.
 *
 * What this is. One Beta-Bernoulli posterior per (context cell, skill), with
 * hierarchical shrinkage from the skill's global posterior, geometric
 * discounting, and a version-hash reset. Ordering is by posterior mean
 * (frozen evaluation) or by a Thompson draw (learning). The update touches
 * ONLY the skill that was read and credited, and only when the gate is
 * open: a deterministic verifier settled the outcome and the run has not
 * been counted before. Unread candidates receive nothing; replay cannot
 * inflate evidence. The posterior-mean step `(r - mean) / (alpha + beta + 1)`
 * is the three-factor form `eta * e * g * (r - b)` with a count-based step
 * size, the read-skill indicator as eligibility, and the per-cell mean as
 * the baseline. Weights are bounded by construction (means live in [0, 1]).
 *
 * What this is not. It is not a co-occurrence (Hebbian) rule, it never
 * removes a skill from the index, and it grants no permission: the index is
 * a routing key, so the prior can only change which description the model
 * reads first. Production wiring is default-off (`skills.prior.enabled`);
 * the ledger is written by the controlled benchmark, not by live runs, until
 * a verified live outcome signal exists.
 */

import type { SkillsPriorConfig } from "../../config/types.skills.js";

export const SKILL_PRIOR_DEFAULTS = {
  mode: "mean" as const,
  /** Geometric forgetting per gated observation in a cell (f-dsw TS form). */
  discount: 0.98,
  /** Pseudo-count carried from the skill's global posterior into a new cell. */
  pseudoCount: 4,
  /** Monte Carlo draws used to estimate P(first) under Thompson ordering. */
  propensityDraws: 64,
  /** Dedupe window for (runId, skill) pairs. */
  seenMax: 5_000,
} as const;

export type SkillPriorMode = "mean" | "thompson" | "off";

/**
 * Where the top-ranked skill goes. Models show a positional preference
 * among near-equivalent descriptions; in the controlled test (Phase 0a,
 * 2026-11-01) Claude Haiku 4.5 read the LATER of two adjacent candidates in
 * 7 of 7 discordant pairs, so "last" is the right placement for that model.
 * The ranking itself is placement-independent.
 */
export type SkillPriorPlacement = "first" | "last";

export interface Posterior {
  /** Skill content hash the statistics were learned under. */
  hash: string;
  alpha: number;
  beta: number;
  /** Gated observations folded in (undiscounted count, for reporting). */
  n: number;
}

export interface SkillPriorLedgerState {
  version: 1;
  /** cell -> skill name -> posterior */
  cells: Record<string, Record<string, Posterior>>;
  /** skill name -> posterior pooled over cells (the hierarchical prior). */
  global: Record<string, Posterior>;
  /** `${runId}|${skill}` pairs already counted. */
  seen: string[];
}

export interface Candidate {
  name: string;
  hash: string;
}

export interface OrderResult {
  /** Candidate names in the order the index should present them. */
  order: string[];
  /** Posterior mean per candidate (the baseline b_c for that skill). */
  means: Record<string, number>;
  /** Thompson draw per candidate (equals the mean under `mode: "mean"`). */
  draws: Record<string, number>;
  /** Estimated probability that each candidate lands first (Thompson only). */
  propensity: Record<string, number> | null;
  mode: SkillPriorMode;
}

export interface UpdateParams {
  cell: string;
  skill: Candidate;
  /** 1 = verified pass, 0 = verified fail. */
  outcome: 0 | 1;
  /** Unique per agent run; the same run never updates twice. */
  runId: string;
  /** False closes the gate: the outcome was not deterministically verified. */
  gate: boolean;
}

export type UpdateResult =
  | { applied: true; cell: string; skill: string; before: number; after: number }
  | { applied: false; reason: "gate-closed" | "duplicate-run" | "invalid-outcome" };

export type Rng = () => number;

export function emptyLedgerState(): SkillPriorLedgerState {
  return { version: 1, cells: {}, global: {}, seen: [] };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Standard normal via Box-Muller. */
function normal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = rng();
  }
  while (v === 0) {
    v = rng();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) via Marsaglia-Tsang; shape < 1 handled by the boost identity. */
export function sampleGamma(shape: number, rng: Rng): number {
  if (!(shape > 0)) {
    return 0;
  }
  if (shape < 1) {
    const u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u === 0 ? Number.EPSILON : u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) {
      return d * v;
    }
    if (Math.log(u === 0 ? Number.EPSILON : u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const a = sampleGamma(alpha, rng);
  const b = sampleGamma(beta, rng);
  const s = a + b;
  return s > 0 ? a / s : 0.5;
}

export class SkillPriorLedger {
  readonly state: SkillPriorLedgerState;
  readonly discount: number;
  readonly pseudoCount: number;

  constructor(
    state?: SkillPriorLedgerState,
    opts: { discount?: number; pseudoCount?: number } = {},
  ) {
    this.state = state ?? emptyLedgerState();
    this.discount = opts.discount ?? SKILL_PRIOR_DEFAULTS.discount;
    this.pseudoCount = opts.pseudoCount ?? SKILL_PRIOR_DEFAULTS.pseudoCount;
  }

  static fromJSON(
    raw: string,
    opts?: { discount?: number; pseudoCount?: number },
  ): SkillPriorLedger {
    const parsed = JSON.parse(raw) as Partial<SkillPriorLedgerState>;
    if (parsed.version !== 1 || typeof parsed.cells !== "object" || !parsed.cells) {
      throw new Error("skill prior ledger: unsupported or malformed state");
    }
    return new SkillPriorLedger(
      {
        version: 1,
        cells: parsed.cells,
        global: parsed.global ?? {},
        seen: Array.isArray(parsed.seen) ? parsed.seen : [],
      },
      opts,
    );
  }

  toJSON(): string {
    return JSON.stringify(this.state);
  }

  /** The skill's pooled posterior, reset when its content hash changed. */
  private globalFor(skill: Candidate): Posterior {
    const g = this.state.global[skill.name];
    if (!g || g.hash !== skill.hash) {
      const fresh: Posterior = { hash: skill.hash, alpha: 1, beta: 1, n: 0 };
      this.state.global[skill.name] = fresh;
      return fresh;
    }
    return g;
  }

  /**
   * The (cell, skill) posterior. A missing cell, or a cell learned under an
   * older content hash, is initialised by hierarchical shrinkage from the
   * skill's global posterior: `alpha0 = 1 + m * p_global`, `beta0 = 1 + m *
   * (1 - p_global)`. A hash change therefore resets every cell for that
   * skill (the version-hash change point) without discarding what the
   * current version has already earned elsewhere.
   */
  posterior(cell: string, skill: Candidate): Posterior {
    const g = this.globalFor(skill);
    const cellMap = (this.state.cells[cell] ??= {});
    const p = cellMap[skill.name];
    if (p && p.hash === skill.hash) {
      return p;
    }
    const pGlobal = g.alpha / (g.alpha + g.beta);
    const fresh: Posterior = {
      hash: skill.hash,
      alpha: 1 + this.pseudoCount * pGlobal,
      beta: 1 + this.pseudoCount * (1 - pGlobal),
      n: 0,
    };
    cellMap[skill.name] = fresh;
    return fresh;
  }

  mean(cell: string, skill: Candidate): number {
    const p = this.posterior(cell, skill);
    return p.alpha / (p.alpha + p.beta);
  }

  /**
   * Order candidates for one decision. Ties (including the untouched state
   * where every mean is 0.5) keep the incoming order, so an empty ledger is
   * exactly the directory-order baseline.
   */
  order(params: {
    cell: string;
    candidates: readonly Candidate[];
    mode: SkillPriorMode;
    rng?: Rng;
  }): OrderResult {
    const rng = params.rng ?? Math.random;
    const means: Record<string, number> = {};
    const draws: Record<string, number> = {};
    const posts = params.candidates.map((c) => ({ c, p: this.posterior(params.cell, c) }));
    for (const { c, p } of posts) {
      means[c.name] = p.alpha / (p.alpha + p.beta);
      draws[c.name] =
        params.mode === "thompson" ? sampleBeta(p.alpha, p.beta, rng) : means[c.name]!;
    }
    if (params.mode === "off") {
      return {
        order: params.candidates.map((c) => c.name),
        means,
        draws,
        propensity: null,
        mode: "off",
      };
    }
    const stableSort = (score: Record<string, number>) =>
      params.candidates
        .map((c, i) => ({ name: c.name, i, s: score[c.name] ?? 0 }))
        .toSorted((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.name);
    const order = stableSort(draws);
    let propensity: Record<string, number> | null = null;
    if (params.mode === "thompson") {
      const counts: Record<string, number> = {};
      const k = SKILL_PRIOR_DEFAULTS.propensityDraws;
      for (let t = 0; t < k; t++) {
        let best: string | null = null;
        let bestScore = -1;
        for (const { c, p } of posts) {
          const s = sampleBeta(p.alpha, p.beta, rng);
          if (s > bestScore) {
            bestScore = s;
            best = c.name;
          }
        }
        if (best) {
          counts[best] = (counts[best] ?? 0) + 1;
        }
      }
      propensity = {};
      for (const { c } of posts) {
        propensity[c.name] = (counts[c.name] ?? 0) / k;
      }
    }
    return { order, means, draws, propensity, mode: params.mode };
  }

  /**
   * The three-factor update, gated. Only the read skill moves; the cell and
   * the global posterior both discount then fold the outcome in.
   */
  update(params: UpdateParams): UpdateResult {
    if (!params.gate) {
      return { applied: false, reason: "gate-closed" };
    }
    if (params.outcome !== 0 && params.outcome !== 1) {
      return { applied: false, reason: "invalid-outcome" };
    }
    const key = `${params.runId}|${params.skill.name}`;
    if (this.state.seen.includes(key)) {
      return { applied: false, reason: "duplicate-run" };
    }
    this.state.seen.push(key);
    if (this.state.seen.length > SKILL_PRIOR_DEFAULTS.seenMax) {
      this.state.seen.splice(0, this.state.seen.length - SKILL_PRIOR_DEFAULTS.seenMax);
    }
    const p = this.posterior(params.cell, params.skill);
    const before = p.alpha / (p.alpha + p.beta);
    const fold = (q: Posterior) => {
      q.alpha = this.discount * q.alpha + params.outcome;
      q.beta = this.discount * q.beta + (1 - params.outcome);
      q.n += 1;
    };
    fold(p);
    fold(this.globalFor(params.skill));
    const after = p.alpha / (p.alpha + p.beta);
    return { applied: true, cell: params.cell, skill: params.skill.name, before, after };
  }

  /**
   * Control arm A4: the same weights, assigned to the wrong cells. For each
   * skill, its per-cell posteriors are permuted across the cells it has
   * statistics in (a derangement when possible), so the distribution of
   * learned values is preserved and the context-to-skill association is
   * destroyed. Global posteriors are untouched.
   */
  shuffledAcrossCells(rng: Rng = Math.random): SkillPriorLedger {
    const clone = SkillPriorLedger.fromJSON(this.toJSON(), {
      discount: this.discount,
      pseudoCount: this.pseudoCount,
    });
    const cells = Object.keys(clone.state.cells);
    const skills = new Set<string>();
    for (const cell of cells) {
      for (const name of Object.keys(clone.state.cells[cell] ?? {})) {
        skills.add(name);
      }
    }
    for (const name of skills) {
      const present = cells.filter((cell) => clone.state.cells[cell]?.[name]);
      if (present.length < 2) {
        continue;
      }
      const perm = derange(present, rng);
      const values = present.map((cell) => clone.state.cells[cell]![name]!);
      present.forEach((cell, i) => {
        const target = perm[i]!;
        clone.state.cells[target]![name] = values[i]!;
      });
    }
    return clone;
  }

  /** Flat view for reports: every (cell, skill) with its mean and count. */
  snapshot(): Array<{ cell: string; skill: string; hash: string; mean: number; n: number }> {
    const out: Array<{ cell: string; skill: string; hash: string; mean: number; n: number }> = [];
    for (const [cell, skills] of Object.entries(this.state.cells)) {
      for (const [skill, p] of Object.entries(skills)) {
        out.push({
          cell,
          skill,
          hash: p.hash,
          mean: clamp01(p.alpha / (p.alpha + p.beta)),
          n: p.n,
        });
      }
    }
    return out.toSorted((a, b) => a.cell.localeCompare(b.cell) || a.skill.localeCompare(b.skill));
  }
}

/** A permutation with no fixed point when n >= 2 (Sattolo's cycle), seeded by `rng`. */
export function derange<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * i);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt surgery
// ---------------------------------------------------------------------------

const SKILL_BLOCK_RE =
  /^[ \t]*<skill>\n[ \t]*<name>([^<\n]*)<\/name>\n[\s\S]*?^[ \t]*<\/skill>\n?/gm;

/** Names in index order, as `skillNamesInPrompt` sees them. */
export function skillOrderInPrompt(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(SKILL_BLOCK_RE)) {
    out.push(m[1] ?? "");
  }
  return out;
}

/**
 * Permute the `<skill>` blocks of a formatted skills prompt into `order`.
 * Names absent from `order` keep their relative position after the ordered
 * ones; names in `order` that are not in the prompt are ignored. Every byte
 * outside the blocks is untouched, so the compactor, the canary filter and
 * the validators see the same shapes they always did.
 */
export function reorderSkillsPrompt(prompt: string, order: readonly string[]): string {
  const matches = [...prompt.matchAll(SKILL_BLOCK_RE)];
  if (matches.length < 2) {
    return prompt;
  }
  const byName = new Map<string, string>();
  const original: string[] = [];
  for (const m of matches) {
    const name = m[1] ?? "";
    byName.set(name, m[0]);
    original.push(name);
  }
  const ranked = order.filter((n) => byName.has(n));
  const rankedSet = new Set(ranked);
  const finalOrder = [...ranked, ...original.filter((n) => !rankedSet.has(n))];
  if (finalOrder.every((n, i) => n === original[i])) {
    return prompt;
  }
  let out = "";
  let cursor = 0;
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    out += prompt.slice(cursor, start);
    out += byName.get(finalOrder[i] ?? "") ?? m[0];
    cursor = start + m[0].length;
  });
  out += prompt.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Run-path application
// ---------------------------------------------------------------------------

export interface ApplySkillPriorParams {
  prompt: string;
  cell: string;
  ledger: SkillPriorLedger;
  /** name -> content hash for the skills in the index; unknown names get hash "unknown". */
  hashes: Readonly<Record<string, string>>;
  mode: SkillPriorMode;
  /** Default "first". */
  placement?: SkillPriorPlacement;
  rng?: Rng;
}

/** The index order for a ranking under a placement: best first, or best last. */
export function placeRanking(ranked: readonly string[], placement: SkillPriorPlacement): string[] {
  return placement === "last" ? ranked.toReversed() : [...ranked];
}

export interface ApplySkillPriorResult {
  prompt: string;
  changed: boolean;
  order: string[];
  baseline: string[];
  result: OrderResult | null;
}

/** Reorder the index for one run and report what moved. Pure. */
export function applySkillPrior(params: ApplySkillPriorParams): ApplySkillPriorResult {
  const baseline = skillOrderInPrompt(params.prompt);
  if (params.mode === "off" || baseline.length < 2) {
    return { prompt: params.prompt, changed: false, order: baseline, baseline, result: null };
  }
  const candidates: Candidate[] = baseline.map((name) => ({
    name,
    hash: params.hashes[name] ?? "unknown",
  }));
  const result = params.ledger.order({
    cell: params.cell,
    candidates,
    mode: params.mode,
    ...(params.rng ? { rng: params.rng } : {}),
  });
  const prompt = reorderSkillsPrompt(
    params.prompt,
    placeRanking(result.order, params.placement ?? "first"),
  );
  return {
    prompt,
    changed: prompt !== params.prompt,
    order: skillOrderInPrompt(prompt),
    baseline,
    result,
  };
}

export function resolveSkillPriorPlacement(
  cfg: SkillsPriorConfig | undefined,
): SkillPriorPlacement {
  return cfg?.placement === "last" ? "last" : "first";
}

export function resolveSkillPriorMode(cfg: SkillsPriorConfig | undefined): SkillPriorMode {
  if (!cfg?.enabled) {
    return "off";
  }
  return cfg.mode === "thompson" ? "thompson" : "mean";
}
