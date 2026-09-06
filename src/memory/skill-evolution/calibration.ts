/**
 * PLAN-45 Phase 1.5: labeler calibration on REAL traces.
 *
 * The heuristic labeler is calibrated against a synthetic fixture built from
 * live run SHAPES (labeler.fixture.test.ts). That proves the rules are
 * consistent; it does not prove they are right on this node's traffic. This
 * module builds a blind labeling set from the journal and scores human
 * labels against the labeler.
 *
 *   export:  N terminal, tool-bearing, first-party runs, stratified across
 *            the labeler's own classes so each class is represented, written
 *            as two files: `blind.jsonl` (id + redacted trace log, nothing
 *            else) for the human, and `key.jsonl` (the labeler's verdicts)
 *            which the human must not open before labeling.
 *   score:   per-class precision / recall / F1 of the labeler against one
 *            human label file; with a second file, Cohen's kappa between the
 *            two humans and the labeler's scores against their consensus.
 *
 * Nothing here feeds the loop; it measures it.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EventJournal } from "../../infra/event-journal.js";
import type { ReconstructedTrace, TraceLabel, TraceLabelResult } from "./types.js";
import { resolveWikiDir, type ImpactTrailOptions } from "../../agents/skills/impact-trail.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { scanSkillForInjection } from "../../security/skill-injection-scanner.js";
import { isA2aTaskSessionKey } from "../../sessions/session-key-utils.js";
import { makeYieldEvery } from "../event-loop.js";
import { type JudgeCallFn, labelHeuristic, labelTrace } from "./labeler.js";
import { deriveRunOutcome } from "./outcome.js";
import { readRunFeedback } from "./run-feedback.js";
import { classifyRunOrigin, isLearnableOrigin } from "./run-origin.js";
import { DEFAULT_EXCLUDED_SESSION_PATTERNS } from "./sampler.js";
import { formatTraceLog, listRunsSinceDetailed, reconstructTrace } from "./traces.js";

const log = createSubsystemLogger("skill-evolution/calibration");

export const CALIBRATION_SUBDIR = "calibration";
export const DEFAULT_CALIBRATION_COUNT = 100;
export const MAX_CALIBRATION_COUNT = 500;
/** Blind logs are for a human reader; long traces are elided head/tail. */
export const BLIND_LOG_MAX_CHARS = 6_000;
const MAX_SCAN_PAGES = 200;
/** Reconstruct at most this many runs per requested row (and at least MIN_RECONSTRUCT). */
const RECONSTRUCT_MULTIPLIER = 4;
const MIN_RECONSTRUCT = 40;
const SCAN_RUNS_PER_PAGE = 400;

export const TRACE_LABELS: readonly TraceLabel[] = ["pass", "fail", "env-fail", "unknown"];

export interface CalibrationBlindRow {
  id: string;
  log: string;
}

export interface CalibrationKeyRow {
  id: string;
  heuristic: { label: TraceLabel; confidence: number; reason: string };
  judged: { label: TraceLabel; confidence: number; reason: string } | null;
  origin: string;
  model: string | null;
  toolCalls: number;
  evidenceLevel: number;
}

export interface CalibrationSet {
  blind: CalibrationBlindRow[];
  key: CalibrationKeyRow[];
  stats: {
    runsScanned: number;
    runsEligible: number;
    runsExcluded: number;
    byHeuristicLabel: Record<string, number>;
    selectedByLabel: Record<string, number>;
    judgeCalls: number;
  };
}

export interface BuildCalibrationSetOptions {
  journal: EventJournal;
  count?: number;
  seed?: string;
  /** When set, the judge also labels every selected trace (two calls each). */
  judgeCall?: JudgeCallFn;
  storeOpts?: ImpactTrailOptions;
  excludedSessionPatterns?: readonly string[];
  now?: number;
}

function seededOrder(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}\n${id}`).digest("hex");
}

/**
 * Walk the whole journal (metadata only) and return terminal, tool-bearing
 * run ids in first-seen order.
 */
async function listTerminalToolRuns(journal: EventJournal): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  let sinceSeq = 0;
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const scan = await listRunsSinceDetailed(journal, {
      sinceSeq,
      maxRuns: SCAN_RUNS_PER_PAGE,
      skipRunIds: seen,
    });
    for (const run of scan.runs) {
      seen.add(run.runId);
      if (run.hasTerminal && run.toolEvents > 0) {
        out.push(run.runId);
      }
    }
    for (const run of scan.skipped) {
      seen.add(run.runId);
    }
    // A deferred run resumes from just BEFORE its first event (the cursor is
    // exclusive), so its first tool event is not lost (adversarial M3).
    const next = scan.deferredMinFirstSeq !== null ? scan.deferredMinFirstSeq - 1 : scan.horizonSeq;
    if (scan.runs.length === 0 || next <= sinceSeq) {
      break;
    }
    sinceSeq = next;
  }
  return out;
}

function isEligible(
  trace: ReconstructedTrace,
  excluded: readonly string[],
): { ok: true; origin: string } | { ok: false } {
  if (!trace.isComplete || trace.toolCallCount === 0 || trace.task?.isHeartbeat) {
    return { ok: false };
  }
  const key = trace.sessionKey ?? "";
  if (excluded.some((p) => key.includes(p)) || isA2aTaskSessionKey(key)) {
    return { ok: false };
  }
  const origin = trace.task?.origin ?? classifyRunOrigin(key);
  if (!isLearnableOrigin(origin)) {
    return { ok: false };
  }
  if (trace.task) {
    const scan = scanSkillForInjection(trace.task.text);
    if (scan.severity === "critical" || scan.severity === "medium") {
      return { ok: false };
    }
  }
  return { ok: true, origin };
}

export async function buildCalibrationSet(
  opts: BuildCalibrationSetOptions,
): Promise<CalibrationSet> {
  const count = Math.max(
    1,
    Math.min(MAX_CALIBRATION_COUNT, opts.count ?? DEFAULT_CALIBRATION_COUNT),
  );
  const seed = opts.seed ?? String(opts.now ?? Date.now());
  const excluded = opts.excludedSessionPatterns ?? DEFAULT_EXCLUDED_SESSION_PATTERNS;
  const feedback = await readRunFeedback(opts.storeOpts ?? {});
  const tick = makeYieldEvery(8);

  // Metadata scan first, then reconstruct only a seeded prefix large enough
  // to fill the sample (adversarial M3): never inflate every run in the
  // journal for a 100-row sample.
  const allRunIds = await listTerminalToolRuns(opts.journal);
  const runIds = allRunIds.toSorted((a, b) =>
    seededOrder(seed, a).localeCompare(seededOrder(seed, b)),
  );
  const reconstructBudget = Math.max(count * RECONSTRUCT_MULTIPLIER, MIN_RECONSTRUCT);
  let reconstructed = 0;
  const byLabel = new Map<
    TraceLabel,
    Array<{ trace: ReconstructedTrace; label: TraceLabelResult; origin: string }>
  >();
  const stats: CalibrationSet["stats"] = {
    runsScanned: allRunIds.length,
    runsEligible: 0,
    runsExcluded: 0,
    byHeuristicLabel: {},
    selectedByLabel: {},
    judgeCalls: 0,
  };
  for (const runId of runIds) {
    if (reconstructed >= reconstructBudget) {
      break;
    }
    await tick();
    reconstructed += 1;
    const trace = await reconstructTrace(opts.journal, runId, { skipMarathonRuns: true });
    if (!trace) {
      stats.runsExcluded += 1;
      continue;
    }
    const eligible = isEligible(trace, excluded);
    if (!eligible.ok) {
      stats.runsExcluded += 1;
      continue;
    }
    stats.runsEligible += 1;
    trace.outcome = deriveRunOutcome(trace, { journal: opts.journal, feedback });
    const label = labelHeuristic(trace);
    stats.byHeuristicLabel[label.label] = (stats.byHeuristicLabel[label.label] ?? 0) + 1;
    const bucket = byLabel.get(label.label) ?? [];
    bucket.push({ trace, label, origin: eligible.origin });
    byLabel.set(label.label, bucket);
  }

  // Stratified, seeded, round-robin across the labeler's classes so a
  // dominant class cannot crowd the rarer ones out of the human's sample.
  for (const bucket of byLabel.values()) {
    bucket.sort((a, b) =>
      seededOrder(seed, a.trace.runId).localeCompare(seededOrder(seed, b.trace.runId)),
    );
  }
  const order = TRACE_LABELS.filter((l) => byLabel.has(l));
  const selected: Array<{ trace: ReconstructedTrace; label: TraceLabelResult; origin: string }> =
    [];
  const cursors = new Map<TraceLabel, number>();
  while (selected.length < count) {
    let progressed = false;
    for (const label of order) {
      const bucket = byLabel.get(label) ?? [];
      const i = cursors.get(label) ?? 0;
      if (i < bucket.length && selected.length < count) {
        selected.push(bucket[i] as (typeof selected)[number]);
        cursors.set(label, i + 1);
        progressed = true;
      }
    }
    if (!progressed) {
      break;
    }
  }

  const blind: CalibrationBlindRow[] = [];
  const key: CalibrationKeyRow[] = [];
  for (const item of selected) {
    await tick();
    let judged: CalibrationKeyRow["judged"] = null;
    if (opts.judgeCall) {
      const j = await labelTrace(item.trace, { judgeCall: opts.judgeCall });
      if (j.judged) {
        stats.judgeCalls += 1;
      }
      judged = { label: j.label, confidence: j.confidence, reason: j.reason };
    }
    stats.selectedByLabel[item.label.label] = (stats.selectedByLabel[item.label.label] ?? 0) + 1;
    blind.push({
      id: item.trace.runId,
      // blind: no outcome line, no tool/error counts, no Signals, no
      // evidence hierarchy (adversarial H1); the raw tool output stays.
      log: redactSensitiveText(
        formatTraceLog(item.trace, { maxChars: BLIND_LOG_MAX_CHARS, blind: true }),
        { mode: "tools" },
      ),
    });
    key.push({
      id: item.trace.runId,
      heuristic: {
        label: item.label.label,
        confidence: item.label.confidence,
        reason: item.label.reason,
      },
      judged,
      origin: item.origin,
      model: item.trace.model,
      toolCalls: item.trace.toolCallCount,
      evidenceLevel: item.trace.outcome?.level ?? 0,
    });
  }
  log.info(
    `calibration set: ${blind.length} traces from ${stats.runsEligible} eligible runs (${JSON.stringify(stats.selectedByLabel)})`,
  );
  return { blind, key, stats };
}

export interface WrittenCalibrationSet {
  dir: string;
  blindPath: string;
  keyPath: string;
  count: number;
}

export async function writeCalibrationSet(
  set: CalibrationSet,
  opts: ImpactTrailOptions & { stamp?: string } = {},
): Promise<WrittenCalibrationSet> {
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(resolveWikiDir(opts), CALIBRATION_SUBDIR, stamp);
  await fs.mkdir(dir, { recursive: true });
  const blindPath = path.join(dir, "blind.jsonl");
  const keyPath = path.join(dir, "key.jsonl");
  await fs.writeFile(blindPath, set.blind.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  await fs.writeFile(keyPath, set.key.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  await fs.writeFile(
    path.join(dir, "README.md"),
    [
      "# Labeler calibration set",
      "",
      "Label every row of blind.jsonl WITHOUT opening key.jsonl. Write one JSON",
      "line per trace to your own file, e.g. labels-<you>.jsonl:",
      "",
      '  {"id":"<run id>","label":"pass|fail|env-fail|unknown","note":"optional"}',
      "",
      "pass = the agent delivered what the task asked; fail = it did not and the",
      "cause was the agent; env-fail = it did not and the cause was the",
      "environment (network, provider, missing external resource); unknown =",
      "you genuinely cannot tell from the trace.",
      "",
      "Then: bitterbot skills calibrate score <this dir> --labels labels-<you>.jsonl",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { dir, blindPath, keyPath, count: set.blind.length };
}

// ── Scoring ──────────────────────────────────────────────────────────────

export interface CalibrationLabelRow {
  id: string;
  label: TraceLabel;
  note?: string;
}

export function parseLabelFile(text: string): CalibrationLabelRow[] {
  const out: CalibrationLabelRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`invalid label row ${out.length + 1}: not JSON`);
    }
    const label = (typeof raw.label === "string" ? raw.label.toLowerCase() : "") as TraceLabel;
    if (typeof raw.id !== "string" || !TRACE_LABELS.includes(label)) {
      throw new Error(
        `invalid label row ${out.length + 1}: expected {"id","label"} with a known label`,
      );
    }
    out.push({ id: raw.id, label, ...(typeof raw.note === "string" ? { note: raw.note } : {}) });
  }
  return out;
}

export async function readKeyFile(dir: string): Promise<CalibrationKeyRow[]> {
  const text = await fs.readFile(path.join(dir, "key.jsonl"), "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CalibrationKeyRow);
}

export interface ClassScore {
  label: TraceLabel;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface LabelerScore {
  n: number;
  accuracy: number;
  perClass: ClassScore[];
  /** confusion[truth][predicted] */
  confusion: Record<string, Record<string, number>>;
}

function scoreAgainst(
  truth: Map<string, TraceLabel>,
  predicted: Map<string, TraceLabel>,
): LabelerScore {
  const ids = [...truth.keys()].filter((id) => predicted.has(id));
  const confusion: Record<string, Record<string, number>> = {};
  let correct = 0;
  for (const id of ids) {
    const t = truth.get(id) as TraceLabel;
    const p = predicted.get(id) as TraceLabel;
    confusion[t] ??= {};
    confusion[t][p] = (confusion[t][p] ?? 0) + 1;
    if (t === p) {
      correct += 1;
    }
  }
  const perClass: ClassScore[] = TRACE_LABELS.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const id of ids) {
      const t = truth.get(id);
      const p = predicted.get(id);
      if (p === label && t === label) tp += 1;
      else if (p === label && t !== label) fp += 1;
      else if (p !== label && t === label) fn += 1;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : null;
    const recall = tp + fn > 0 ? tp / (tp + fn) : null;
    const f1 =
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null;
    return { label, tp, fp, fn, precision, recall, f1 };
  });
  return {
    n: ids.length,
    accuracy: ids.length > 0 ? correct / ids.length : 0,
    perClass,
    confusion,
  };
}

/** Cohen's kappa over the ids both raters labeled. */
export function cohensKappa(
  a: Map<string, TraceLabel>,
  b: Map<string, TraceLabel>,
): {
  n: number;
  agreement: number;
  kappa: number | null;
} {
  const ids = [...a.keys()].filter((id) => b.has(id));
  const n = ids.length;
  if (n === 0) {
    return { n: 0, agreement: 0, kappa: null };
  }
  let agree = 0;
  const ca: Record<string, number> = {};
  const cb: Record<string, number> = {};
  for (const id of ids) {
    const la = a.get(id) as string;
    const lb = b.get(id) as string;
    if (la === lb) agree += 1;
    ca[la] = (ca[la] ?? 0) + 1;
    cb[lb] = (cb[lb] ?? 0) + 1;
  }
  const po = agree / n;
  let pe = 0;
  for (const label of TRACE_LABELS) {
    pe += ((ca[label] ?? 0) / n) * ((cb[label] ?? 0) / n);
  }
  const kappa = pe >= 1 ? null : (po - pe) / (1 - pe);
  return { n, agreement: po, kappa };
}

export interface CalibrationReport {
  keyCount: number;
  raterA: { n: number; unlabeled: number };
  raterB: { n: number; unlabeled: number } | null;
  interRater: { n: number; agreement: number; kappa: number | null } | null;
  heuristicVsA: LabelerScore;
  judgedVsA: LabelerScore | null;
  heuristicVsConsensus: LabelerScore | null;
  judgedVsConsensus: LabelerScore | null;
}

export function scoreCalibration(
  key: CalibrationKeyRow[],
  raterA: CalibrationLabelRow[],
  raterB?: CalibrationLabelRow[],
): CalibrationReport {
  const keyIds = new Set(key.map((k) => k.id));
  const heuristic = new Map(key.map((k) => [k.id, k.heuristic.label]));
  const judgedRows = key.filter((k) => k.judged);
  const judged =
    judgedRows.length > 0 ? new Map(judgedRows.map((k) => [k.id, k.judged!.label])) : null;
  const a = new Map(raterA.filter((r) => keyIds.has(r.id)).map((r) => [r.id, r.label]));
  const b = raterB
    ? new Map(raterB.filter((r) => keyIds.has(r.id)).map((r) => [r.id, r.label]))
    : null;
  let consensus: Map<string, TraceLabel> | null = null;
  if (b) {
    consensus = new Map();
    for (const [id, la] of a) {
      if (b.get(id) === la) {
        consensus.set(id, la);
      }
    }
  }
  return {
    keyCount: key.length,
    raterA: { n: a.size, unlabeled: key.length - a.size },
    raterB: b ? { n: b.size, unlabeled: key.length - b.size } : null,
    interRater: b ? cohensKappa(a, b) : null,
    heuristicVsA: scoreAgainst(a, heuristic),
    judgedVsA: judged ? scoreAgainst(a, judged) : null,
    heuristicVsConsensus: consensus ? scoreAgainst(consensus, heuristic) : null,
    judgedVsConsensus: consensus && judged ? scoreAgainst(consensus, judged) : null,
  };
}

export function formatCalibrationReport(report: CalibrationReport): string {
  const fmt = (v: number | null) => (v === null ? "  n/a" : v.toFixed(2).padStart(5));
  const block = (title: string, s: LabelerScore | null) => {
    if (!s) {
      return [];
    }
    const lines = [`${title}: n=${s.n} accuracy=${s.accuracy.toFixed(2)}`];
    for (const c of s.perClass) {
      lines.push(
        `  ${c.label.padEnd(9)} P=${fmt(c.precision)} R=${fmt(c.recall)} F1=${fmt(c.f1)}  (tp ${c.tp} fp ${c.fp} fn ${c.fn})`,
      );
    }
    return lines;
  };
  const out = [
    `key rows: ${report.keyCount}; rater A labeled ${report.raterA.n} (${report.raterA.unlabeled} unlabeled)`,
  ];
  if (report.raterB) {
    out.push(`rater B labeled ${report.raterB.n} (${report.raterB.unlabeled} unlabeled)`);
  }
  if (report.interRater) {
    out.push(
      `inter-rater: n=${report.interRater.n} agreement=${report.interRater.agreement.toFixed(2)} kappa=${report.interRater.kappa === null ? "n/a" : report.interRater.kappa.toFixed(2)}`,
    );
  }
  out.push(...block("heuristic vs rater A", report.heuristicVsA));
  out.push(...block("judge vs rater A", report.judgedVsA));
  out.push(...block("heuristic vs consensus", report.heuristicVsConsensus));
  out.push(...block("judge vs consensus", report.judgedVsConsensus));
  return out.join("\n");
}
