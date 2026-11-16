/**
 * Cross-agent evidence cards (pure core for cross-agent-run.ts).
 *
 * The question: does a recipient agent do better with outcome records that
 * OTHER agents earned than with the records it earned itself, when every
 * agent spends the same budget? Each agent (one recipient, N donors) works
 * `budget` episodes in every `<workspace>:<family>` cell of the
 * latent-convention pool with accept/reject feedback only. A donor exports
 * what it learned as a signed card bundle; the recipient verifies each bundle
 * and shows the pooled peer record next to its own on the skills index.
 *
 * Everything here is deterministic and free of model calls: the bundle
 * format, the arms and the lines they show, the reference reader used for
 * dry runs, and the cell-level analysis.
 */

import { createHash } from "node:crypto";
import { signRecord, verifyRecord } from "../../src/agents/skills/collective/signatures.js";
import { type SkillEvidence, verbalRecord } from "../../src/agents/skills/skill-prior.js";
import { type KeyPair, generateKeyPair } from "../../src/commerce/envelope.js";
import type { JsonValue } from "../../src/commerce/sku.js";
import { exactSignTest } from "../../src/memory/skill-evolution/sign-test.js";
import { clusterBootstrapCi, shuffled } from "./conventions-analysis.js";
import { mulberry32 } from "./tasks.js";

export { generateKeyPair, type KeyPair };

export type Records = Record<string, SkillEvidence>;
/** cell -> skill -> counts */
export type CellRecords = Record<string, Records>;

// ------------------------------------------------------------------ bundles

export const CARD_PROTOCOL = "bitterbot/skill-cards/1";

/** What a donor sends: outcome counts per cell and skill, bound to skill content. */
export interface CardBundle {
  protocol: typeof CARD_PROTOCOL;
  /** `ed25519:<64 hex>`: the donor's public key, which is also its identity. */
  origin: string;
  /** Model that earned the records (reported, for cross-model analysis). */
  model: string;
  /** Episodes the donor spent per cell. */
  budget: number;
  /** skill name -> sha256 of the SKILL.md the records are about. */
  skills: Record<string, string>;
  cells: CellRecords;
  signature: string;
}

export function originOf(key: KeyPair): string {
  return `ed25519:${key.publicKeyHex}`;
}

export function exportCardBundle(args: {
  key: KeyPair;
  model: string;
  budget: number;
  skills: Readonly<Record<string, string>>;
  cells: CellRecords;
}): CardBundle {
  const cells: CellRecords = {};
  for (const [cell, recs] of Object.entries(args.cells)) {
    const kept = Object.fromEntries(Object.entries(recs).filter(([, e]) => e.runs > 0));
    if (Object.keys(kept).length > 0) {
      cells[cell] = kept;
    }
  }
  const used = new Set(Object.values(cells).flatMap((r) => Object.keys(r)));
  return signRecord(
    CARD_PROTOCOL,
    {
      protocol: CARD_PROTOCOL,
      origin: originOf(args.key),
      model: args.model,
      budget: args.budget,
      skills: Object.fromEntries(Object.entries(args.skills).filter(([name]) => used.has(name))),
      cells,
    },
    args.key,
  ) as CardBundle;
}

export type ImportResult =
  | { ok: true; origin: string; cells: CellRecords; dropped: string[] }
  | { ok: false; reason: string };

const isCount = (e: unknown): e is SkillEvidence => {
  const x = e as Partial<SkillEvidence> | null;
  return (
    !!x &&
    Number.isSafeInteger(x.passed) &&
    Number.isSafeInteger(x.runs) &&
    x.passed! >= 0 &&
    x.runs! >= x.passed!
  );
};

/**
 * The recipient's side of the exchange. A bundle is used only if its
 * signature verifies against its stated origin, the origin is one the
 * recipient accepts, and no claim exceeds the stated budget. Records about a
 * skill whose content differs from the recipient's copy are dropped: a card
 * is evidence about one exact SKILL.md, not about a name.
 */
export function importCardBundle(
  input: unknown,
  opts: {
    localSkills: Readonly<Record<string, string>>;
    trustedOrigins?: ReadonlySet<string>;
    maxBudget?: number;
  },
): ImportResult {
  const b = input as Partial<CardBundle> | null;
  if (
    !b ||
    b.protocol !== CARD_PROTOCOL ||
    typeof b.origin !== "string" ||
    typeof b.signature !== "string" ||
    typeof b.model !== "string" ||
    !Number.isSafeInteger(b.budget) ||
    !b.cells ||
    typeof b.cells !== "object" ||
    !b.skills ||
    typeof b.skills !== "object"
  ) {
    return { ok: false, reason: "malformed bundle" };
  }
  if (!verifyRecord(CARD_PROTOCOL, b as CardBundle, b.origin)) {
    return { ok: false, reason: "bad signature" };
  }
  if (opts.trustedOrigins && !opts.trustedOrigins.has(b.origin)) {
    return { ok: false, reason: "origin not trusted" };
  }
  const budget = Math.min(b.budget!, opts.maxBudget ?? Number.POSITIVE_INFINITY);
  const cells: CellRecords = {};
  const dropped: string[] = [];
  for (const [cell, recs] of Object.entries(b.cells)) {
    if (!recs || typeof recs !== "object") {
      return { ok: false, reason: `malformed cell ${cell}` };
    }
    let cellRuns = 0;
    const kept: Records = {};
    for (const [skill, e] of Object.entries(recs)) {
      if (!isCount(e)) {
        return { ok: false, reason: `malformed record ${cell}/${skill}` };
      }
      cellRuns += e.runs;
      if (opts.localSkills[skill] === undefined || opts.localSkills[skill] !== b.skills[skill]) {
        dropped.push(`${cell}/${skill}`);
        continue;
      }
      kept[skill] = { passed: e.passed, runs: e.runs };
    }
    if (cellRuns > budget) {
      return { ok: false, reason: `cell ${cell} claims ${cellRuns} runs on a budget of ${budget}` };
    }
    if (Object.keys(kept).length > 0) {
      cells[cell] = kept;
    }
  }
  return { ok: true, origin: b.origin, cells, dropped };
}

/** Sum counts across sources; `agents` is how many contributed at least one run. */
export function poolRecords(sources: readonly Records[]): { records: Records; agents: number } {
  const records: Records = {};
  let agents = 0;
  for (const src of sources) {
    let any = false;
    for (const [skill, e] of Object.entries(src)) {
      if (e.runs > 0) {
        any = true;
        const t = (records[skill] ??= { passed: 0, runs: 0 });
        t.passed += e.passed;
        t.runs += e.runs;
      }
    }
    agents += any ? 1 : 0;
  }
  return { records, agents };
}

// --------------------------------------------------------------------- arms

/**
 * Evaluation arms. Every arm sees the same instances in the same index order;
 * only the `<evidence>` lines differ.
 *
 *   none            no card (cold start)
 *   own-half        the recipient's own first half of its budget
 *   own             the recipient's own full budget
 *   peer1           one donor's full budget (same amount of experience as `own`)
 *   peer            all donors' budgets pooled (the network arm)
 *   own-half+peer   own first half plus the pool
 *   own+peer        own full budget plus the pool
 *   peer-liar       the pool with one donor replaced by a signed, false report
 *   stale           the pool earned in another workspace with a different convention
 *   own+stale       own full budget plus that misapplied pool
 *   placebo         the pool's usage counts with no outcome
 *   oracle          exact records (ceiling)
 */
export const XA_ARMS = [
  "none",
  "own-half",
  "own",
  "peer1",
  "peer",
  "own-half+peer",
  "own+peer",
  "peer-liar",
  "stale",
  "own+stale",
  "placebo",
  "oracle",
] as const;
export type XaArm = (typeof XA_ARMS)[number];

/** What one arm shows for one cell: the recipient's own counts and the peer pool. */
export interface CardView {
  own?: Records;
  peer?: { records: Records; agents: number };
  /** Peer line carries usage only (placebo). */
  peerUsageOnly?: boolean;
}

const agentsText = (n: number) => (n === 1 ? "1 other agent" : `${n} other agents`);

/**
 * The `<evidence>` text per variant. When an arm has any record in the cell,
 * every variant of the family gets a line, so "not tried yet" is visible and
 * elimination is possible (the verbal format the single-agent studies
 * confirmed). Sources are named so the reader can weigh them.
 */
export function cardLines(view: CardView, variants: readonly string[]): Record<string, string> {
  const total = (r: Records | undefined) => variants.reduce((s, v) => s + (r?.[v]?.runs ?? 0), 0);
  const showOwn = view.own !== undefined && total(view.own) > 0;
  const showPeer = view.peer !== undefined && total(view.peer.records) > 0;
  const out: Record<string, string> = {};
  if (!showOwn && !showPeer) {
    return out;
  }
  for (const v of variants) {
    const parts: string[] = [];
    if (showOwn) {
      parts.push(`Your own runs here: ${verbalRecord(view.own![v] ?? { passed: 0, runs: 0 })}.`);
    }
    if (showPeer) {
      const e = view.peer!.records[v] ?? { passed: 0, runs: 0 };
      const body = view.peerUsageOnly
        ? `${e.runs} ${e.runs === 1 ? "run" : "runs"} logged`
        : verbalRecord(e);
      parts.push(`Runs here by ${agentsText(view.peer!.agents)}: ${body}.`);
    }
    out[v] = parts.join(" ");
  }
  return out;
}

/**
 * A signed but false report that stays inside the donor budget: the right
 * variant rejected, one wrong variant accepted.
 */
export function liarRecords(
  correct: string,
  decoys: readonly string[],
  budget: number,
  seed: string,
): Records {
  const promoted = shuffled(decoys, seed)[0]!;
  const against = Math.floor(budget / 2);
  const out: Records = { [promoted]: { passed: budget - against, runs: budget - against } };
  if (against > 0) {
    out[correct] = { passed: 0, runs: against };
  }
  return out;
}

export function oracleRecords(correct: string, decoys: readonly string[], runs: number): Records {
  return Object.fromEntries([
    [correct, { passed: runs, runs }],
    ...decoys.map((d) => [d, { passed: 0, runs }] as const),
  ]);
}

export interface ArmInputs {
  /** Recipient's own counts after the first half of its budget, and after all of it. */
  ownHalf: Records;
  own: Records;
  /** Verified donor records for this cell, one entry per donor, in donor order. */
  donors: readonly Records[];
  /** The same donors' records for this family in a workspace with another convention. */
  staleDonors: readonly Records[];
  correct: string;
  decoys: readonly string[];
  budget: number;
  /** Seeds every per-cell random choice (which donor lies, which decoy is promoted). */
  seed: string;
}

export function viewFor(arm: XaArm, x: ArmInputs): CardView {
  const pool = poolRecords(x.donors);
  switch (arm) {
    case "none":
      return {};
    case "own-half":
      return { own: x.ownHalf };
    case "own":
      return { own: x.own };
    case "peer1":
      return { peer: poolRecords(x.donors.slice(0, 1)) };
    case "peer":
      return { peer: pool };
    case "own-half+peer":
      return { own: x.ownHalf, peer: pool };
    case "own+peer":
      return { own: x.own, peer: pool };
    case "peer-liar": {
      const liar = x.donors.length
        ? Math.floor(mulberry32(hash32(`${x.seed}:liar`))() * x.donors.length)
        : 0;
      const lie = liarRecords(x.correct, x.decoys, x.budget, x.seed);
      return { peer: poolRecords(x.donors.map((d, i) => (i === liar ? lie : d))) };
    }
    case "stale":
      return { peer: poolRecords(x.staleDonors) };
    case "own+stale":
      return { own: x.own, peer: poolRecords(x.staleDonors) };
    case "placebo":
      return { peer: pool, peerUsageOnly: true };
    case "oracle":
      return {
        peer: {
          records: oracleRecords(x.correct, x.decoys, x.budget),
          agents: Math.max(1, x.donors.length),
        },
      };
  }
}

function hash32(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32BE(0);
}

// --------------------------------------------------------- reference reader

/**
 * Probability that a reader who uses the card perfectly opens the right
 * variant: pick the best accepted rate; with nothing accepted, pick among
 * untried variants; with everything tried and rejected, pick the least
 * rejected. Ties split evenly. Own and peer counts are summed. This is the
 * information ceiling of an arm, and the policy of the dry-run agent.
 */
export function referencePick(view: CardView, variants: readonly string[]): Record<string, number> {
  const usable: Records[] = [];
  if (view.own) {
    usable.push(view.own);
  }
  if (view.peer && !view.peerUsageOnly) {
    usable.push(view.peer.records);
  }
  const rec = poolRecords(usable).records;
  const e = (v: string) => rec[v] ?? { passed: 0, runs: 0 };
  const accepted = variants.filter((v) => e(v).passed > 0);
  let top: string[];
  if (accepted.length > 0) {
    const best = Math.max(...accepted.map((v) => e(v).passed / e(v).runs));
    top = accepted.filter((v) => e(v).passed / e(v).runs === best);
  } else {
    const untried = variants.filter((v) => e(v).runs === 0);
    if (untried.length > 0) {
      top = untried;
    } else {
      const least = Math.min(...variants.map((v) => e(v).runs));
      top = variants.filter((v) => e(v).runs === least);
    }
  }
  return Object.fromEntries(variants.map((v) => [v, top.includes(v) ? 1 / top.length : 0]));
}

// ----------------------------------------------------------------- analysis

export interface EvalRow {
  arm: string;
  cell: string;
  family: string;
  taskId: string;
  pass: number;
}

/** Mean pass per cell for one arm. The CELL is the unit: its tasks share one card. */
export function cellMeans(rows: readonly EvalRow[], arm: string): Map<string, number> {
  const acc = new Map<string, number[]>();
  for (const r of rows) {
    if (r.arm === arm) {
      acc.set(r.cell, [...(acc.get(r.cell) ?? []), r.pass]);
    }
  }
  return new Map([...acc].map(([c, xs]) => [c, xs.reduce((s, x) => s + x, 0) / xs.length]));
}

const familyOfCell = (cell: string) => cell.slice(cell.indexOf(":") + 1);

export interface CellContrast {
  label: string;
  /** Cells present in every arm of the contrast. */
  n: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
  wins: number;
  losses: number;
  ties: number;
  p: number | null;
}

/**
 * A linear contrast of arm means, computed per cell and summarised over
 * cells: mean, family-cluster bootstrap interval, exact sign test.
 * `terms` is e.g. [["peer", 1], ["own", -1]] for peer minus own, or four
 * terms for a difference in differences.
 */
export function cellContrast(
  rows: readonly EvalRow[],
  label: string,
  terms: ReadonlyArray<readonly [string, number]>,
  onlyCells?: ReadonlySet<string>,
): CellContrast {
  const means = terms.map(([arm]) => cellMeans(rows, arm));
  const cells = [...(means[0]?.keys() ?? [])].filter(
    (c) => means.every((m) => m.has(c)) && (!onlyCells || onlyCells.has(c)),
  );
  const deltas = cells.map((c) => terms.reduce((s, [, w], i) => s + w * means[i]!.get(c)!, 0));
  if (deltas.length === 0) {
    return { label, n: 0, mean: null, lo: null, hi: null, wins: 0, losses: 0, ties: 0, p: null };
  }
  const byFamily = new Map<string, number[]>();
  cells.forEach((c, i) => {
    const f = familyOfCell(c);
    byFamily.set(f, [...(byFamily.get(f) ?? []), deltas[i]!]);
  });
  const ci = clusterBootstrapCi(byFamily);
  const sign = exactSignTest(deltas);
  return {
    label,
    n: deltas.length,
    mean: ci?.mean ?? null,
    lo: ci?.lo ?? null,
    hi: ci?.hi ?? null,
    wins: sign.wins,
    losses: sign.losses,
    ties: sign.ties,
    p: sign.pValue,
  };
}

/** Task-level flips between two arms: failures turned into passes, and the reverse. */
export function flips(
  rows: readonly EvalRow[],
  arm: string,
  base: string,
): { up: number; down: number; same: number } {
  const by = (a: string) => new Map(rows.filter((r) => r.arm === a).map((r) => [r.taskId, r.pass]));
  const x = by(arm);
  const y = by(base);
  let up = 0;
  let down = 0;
  let same = 0;
  for (const [task, p] of x) {
    const q = y.get(task);
    if (q === undefined) {
      continue;
    }
    if (p > q) {
      up++;
    } else if (p < q) {
      down++;
    } else {
      same++;
    }
  }
  return { up, down, same };
}

/** The confirmatory family, tested in this fixed order; the first failure ends it. */
export interface GateStep {
  id: string;
  claim: string;
  terms: ReadonlyArray<readonly [string, number]>;
  /** Passes when the interval's lower bound is above this (0 for superiority). */
  lowerBoundAbove: number;
  /** Superiority steps also need a one-sided exact sign-test p below SIGN_ALPHA. */
  needsSignTest: boolean;
}

/** One-sided level of the sign test (the same bar as a two-sided 0.05). */
export const SIGN_ALPHA = 0.025;

export const GATE: readonly GateStep[] = [
  {
    id: "primary",
    claim: "Pooled peer cards beat the recipient's own experience at equal per-agent budget",
    terms: [
      ["peer", 1],
      ["own", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "content",
    claim: "The gain comes from the outcomes, not from the presence of a peer line",
    terms: [
      ["peer", 1],
      ["placebo", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "coverage",
    claim: "Peer cards help most when the recipient has no experience of its own",
    terms: [
      ["peer", 1],
      ["none", -1],
      ["own+peer", -1],
      ["own", 1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: false,
  },
  {
    id: "liar",
    claim: "A pool with one lying donor still beats no card",
    terms: [
      ["peer-liar", 1],
      ["none", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
];

export interface GateResult extends CellContrast {
  id: string;
  claim: string;
  passed: boolean;
  /** False once an earlier step has failed: the result is then exploratory. */
  confirmatory: boolean;
}

export function runGate(rows: readonly EvalRow[], gate: readonly GateStep[] = GATE): GateResult[] {
  let open = true;
  return gate.map((step) => {
    const c = cellContrast(rows, step.id, step.terms);
    const passed =
      c.lo !== null &&
      c.lo > step.lowerBoundAbove &&
      (!step.needsSignTest || (c.p !== null && c.p < SIGN_ALPHA));
    const confirmatory = open;
    open = open && passed;
    return { ...c, id: step.id, claim: step.claim, passed, confirmatory };
  });
}

const pp = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}`);

export function renderGate(results: readonly GateResult[]): string {
  const lines = [
    "| Step | Claim | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p | Result |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of results) {
    const verdict = r.confirmatory
      ? r.passed
        ? "CONFIRMED"
        : "NOT CONFIRMED"
      : `exploratory (${r.passed ? "meets" : "misses"} its criterion)`;
    lines.push(
      `| ${r.id} | ${r.claim} | ${r.n} | ${pp(r.mean)} | [${pp(r.lo)}, ${pp(r.hi)}] | ${r.wins} / ${r.losses} / ${r.ties} | ${r.p === null ? "n/a" : r.p.toFixed(4)} | ${verdict} |`,
    );
  }
  return lines.join("\n");
}

export function renderContrastRows(cs: readonly CellContrast[]): string {
  const lines = [
    "| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const c of cs) {
    lines.push(
      `| ${c.label} | ${c.n} | ${pp(c.mean)} | [${pp(c.lo)}, ${pp(c.hi)}] | ${c.wins} / ${c.losses} / ${c.ties} | ${c.p === null ? "n/a" : c.p.toFixed(4)} |`,
    );
  }
  return lines.join("\n");
}

/** Canonical JSON-safe view of a bundle set, for the protocol hash. */
export function bundleDigest(bundles: readonly CardBundle[]): string {
  return createHash("sha256")
    .update(JSON.stringify(bundles.map((b) => b.signature) as JsonValue))
    .digest("hex");
}

// ------------------------------------------- follow-up: live pool and guards
//
// Registered after the first study's interim read (2026-11-15), before any of
// these arms ran. Three changes to how a pool is built and read:
//
//   live     donors work one after another and each sees what the others have
//            already recorded in the cell, so they stop repeating each other
//   quorum   one vote per donor per variant; a verdict is shown only when at
//            least QUORUM distinct donors agree and outnumber the dissent
//   guard    a donor whose records contradict the recipient's own verified
//            outcomes is dropped, and own outcomes speak for any variant the
//            recipient has tried

export const QUORUM = 2;
/** A donor is dropped at this many contradictions, when they are this share of the checks. */
export const TRUST_MIN_CONTRADICTIONS = 3;
export const TRUST_MAX_RATE = 0.25;

const verdictOf = (e: SkillEvidence | undefined): "accepted" | "rejected" | null =>
  !e || e.runs === 0 ? null : e.passed === e.runs ? "accepted" : e.passed === 0 ? "rejected" : null;

export interface DonorTrust {
  /** (cell, skill) pairs where both sides hold a unanimous record. */
  checks: number;
  contradictions: number;
  trusted: boolean;
}

/** Score a donor only against outcomes the recipient verified itself. */
export function donorTrust(own: CellRecords, donor: CellRecords): DonorTrust {
  let checks = 0;
  let contradictions = 0;
  for (const [cell, recs] of Object.entries(donor)) {
    for (const [skill, e] of Object.entries(recs)) {
      const mine = verdictOf(own[cell]?.[skill]);
      const theirs = verdictOf(e);
      if (mine && theirs) {
        checks++;
        contradictions += mine === theirs ? 0 : 1;
      }
    }
  }
  const trusted = !(
    contradictions >= TRUST_MIN_CONTRADICTIONS && contradictions / checks >= TRUST_MAX_RATE
  );
  return { checks, contradictions, trusted };
}

/**
 * Pool by votes instead of counts. Each donor casts at most one vote per
 * variant; the verdict shown is the side with at least `quorum` votes and
 * strictly more than the other side. Anything else is left out, so the
 * variant reads "not tried yet" and no single signer can move a line.
 */
export function quorumRecords(
  sources: readonly Records[],
  quorum = QUORUM,
): { records: Records; agents: number } {
  const votes = new Map<string, { accept: number; reject: number }>();
  let agents = 0;
  for (const src of sources) {
    let any = false;
    for (const [skill, e] of Object.entries(src)) {
      if (e.runs === 0) {
        continue;
      }
      any = true;
      const v = votes.get(skill) ?? { accept: 0, reject: 0 };
      if (e.passed > 0) {
        v.accept++;
      } else {
        v.reject++;
      }
      votes.set(skill, v);
    }
    agents += any ? 1 : 0;
  }
  const records: Records = {};
  for (const [skill, v] of votes) {
    if (v.accept >= quorum && v.accept > v.reject) {
      records[skill] = { passed: v.accept, runs: v.accept };
    } else if (v.reject >= quorum && v.reject > v.accept) {
      records[skill] = { passed: 0, runs: v.reject };
    }
  }
  return { records, agents };
}

/** Pool the trusted donors, leaving out any variant the recipient has tried itself. */
export function guardedPool(
  own: Records,
  donors: readonly Records[],
  trusted: readonly boolean[],
): { records: Records; agents: number } {
  const kept = donors
    .filter((_, i) => trusted[i] !== false)
    .map((d) => Object.fromEntries(Object.entries(d).filter(([s]) => !(own[s]?.runs ?? 0))));
  return poolRecords(kept);
}

/**
 * Follow-up arms, run on the first study's instances and index order.
 *
 *   live                 the live cohort's pool, counts summed
 *   own+live             own full budget plus the live pool
 *   live-liar            live pool with one donor replaced by the liar, counts summed
 *   live-liar-quorum     the same pool read by quorum
 *   own+liar             own plus the first study's pool with one donor lying everywhere
 *   own+liar-guarded     the same, with the guard
 *   own+stale-guarded    own plus the misapplied pool, with the guard
 */
export const XA2_ARMS = [
  "live",
  "own+live",
  "live-liar",
  "live-liar-quorum",
  "own+liar",
  "own+liar-guarded",
  "own+stale-guarded",
] as const;
export type Xa2Arm = (typeof XA2_ARMS)[number];

export interface Arm2Inputs {
  own: Records;
  /** First-study donors and the live cohort, this cell, in donor order. */
  donors: readonly Records[];
  live: readonly Records[];
  staleDonors: readonly Records[];
  /** Which donor lies (the same one in every cell), and what it says here. */
  liarIndex: number;
  lie: Records;
  /** Per-donor trust under each scenario, computed across all cells. */
  trustWithLiar: readonly boolean[];
  trustStale: readonly boolean[];
}

export function viewFor2(arm: Xa2Arm, x: Arm2Inputs): CardView {
  const withLiar = (ds: readonly Records[]) => ds.map((d, i) => (i === x.liarIndex ? x.lie : d));
  switch (arm) {
    case "live":
      return { peer: poolRecords(x.live) };
    case "own+live":
      return { own: x.own, peer: poolRecords(x.live) };
    case "live-liar":
      return { peer: poolRecords(withLiar(x.live)) };
    case "live-liar-quorum":
      return { peer: quorumRecords(withLiar(x.live)) };
    case "own+liar":
      return { own: x.own, peer: poolRecords(withLiar(x.donors)) };
    case "own+liar-guarded":
      return { own: x.own, peer: guardedPool(x.own, withLiar(x.donors), x.trustWithLiar) };
    case "own+stale-guarded":
      return { own: x.own, peer: guardedPool(x.own, x.staleDonors, x.trustStale) };
  }
}

export const GATE2: readonly GateStep[] = [
  {
    id: "live",
    claim: "A live pool beats a one-off exchange built from the same number of episodes",
    terms: [
      ["live", 1],
      ["peer", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "quorum",
    claim: "A live pool with one lying donor, read by quorum, still beats no card",
    terms: [
      ["live-liar-quorum", 1],
      ["none", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "guard",
    claim: "Checking donors against own outcomes removes the harm of a lying donor",
    terms: [
      ["own+liar-guarded", 1],
      ["own+liar", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
];

/**
 * Replication (registered 2026-11-16 before any run): the two defences as the
 * confirmatory family, on fresh instances, with a fresh recipient and donors
 * that may run on another model. Arms come from both earlier sets.
 */
export const REP_ARMS = [
  "none",
  "own",
  "own+peer",
  "own+liar",
  "own+liar-guarded",
  "live",
  "live-liar",
  "live-liar-quorum",
] as const;
export type RepArm = (typeof REP_ARMS)[number];

export const GATE_REP: readonly GateStep[] = [
  {
    id: "guard",
    claim: "Checking donors against own outcomes removes the harm of a lying donor",
    terms: [
      ["own+liar-guarded", 1],
      ["own+liar", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "quorum",
    claim: "A live pool with one lying donor, read by quorum, still beats no card",
    terms: [
      ["live-liar-quorum", 1],
      ["none", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
  {
    id: "net-gain",
    claim: "A guarded pool containing a liar still adds to the recipient's own experience",
    terms: [
      ["own+liar-guarded", 1],
      ["own", -1],
    ],
    lowerBoundAbove: 0,
    needsSignTest: true,
  },
];
