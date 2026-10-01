/**
 * Metrics and the markdown report (PLAN-52A Sections 5.5 and 5.6).
 */

import { bootstrapMeanCi } from "../../src/memory/skill-evolution/bootstrap-ci.js";
import type { Arm } from "./arms.js";
import { ARM_NAMES } from "./arms.js";
import type { EvalModel } from "./llm.js";
import type { Probe, ProbeType } from "./probes.js";

export type ResultRow = {
  cutId: string;
  set: string;
  probeId: string;
  probeType: ProbeType;
  answerableFromDialogue: boolean;
  needsToolOutput: boolean;
  arm: Arm;
  model: EvalModel;
  answer: string;
  verdict: "correct" | "partial" | "wrong" | "abstain";
  judged: "fast" | "llm";
  correct: number;
  hallucinated: number;
  costUsd: number;
  buildCostUsd: number;
  durationMs: number;
  inputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  usedRecall: boolean;
  error?: string;
};

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}
function pctile(xs: number[], p: number): number {
  if (!xs.length) {
    return 0;
  }
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export type ArmSummary = {
  arm: Arm;
  n: number;
  accuracy: number;
  partial: number;
  abstain: number;
  hallucination: number;
  negatives: number;
  costMedian: number;
  costP95: number;
  latencyP50: number;
  latencyP95: number;
  inputMean: number;
  cacheReadMean: number;
  reachRate: number | null;
  toolOutputAccuracy: number | null;
  dialogueAccuracy: number | null;
  errors: number;
};

export function summarizeArm(rows: ResultRow[], arm: Arm): ArmSummary {
  const r = rows.filter((x) => x.arm === arm);
  const nonNeg = r.filter((x) => x.probeType !== "negative");
  const neg = r.filter((x) => x.probeType === "negative");
  const tool = nonNeg.filter((x) => x.needsToolOutput);
  const dlg = nonNeg.filter((x) => x.answerableFromDialogue);
  return {
    arm,
    n: r.length,
    accuracy: mean(nonNeg.map((x) => x.correct)),
    partial: mean(nonNeg.map((x) => (x.verdict === "partial" ? 1 : 0))),
    abstain: mean(nonNeg.map((x) => (x.verdict === "abstain" ? 1 : 0))),
    hallucination: mean(neg.map((x) => x.hallucinated)),
    negatives: neg.length,
    costMedian: pctile(
      r.map((x) => x.costUsd),
      0.5,
    ),
    costP95: pctile(
      r.map((x) => x.costUsd),
      0.95,
    ),
    latencyP50: pctile(
      r.map((x) => x.durationMs),
      0.5,
    ),
    latencyP95: pctile(
      r.map((x) => x.durationMs),
      0.95,
    ),
    inputMean: mean(r.map((x) => x.inputTokens + x.cacheReadTokens)),
    cacheReadMean: mean(r.map((x) => x.cacheReadTokens)),
    reachRate: arm >= 4 && nonNeg.length ? mean(nonNeg.map((x) => (x.usedRecall ? 1 : 0))) : null,
    toolOutputAccuracy: tool.length ? mean(tool.map((x) => x.correct)) : null,
    dialogueAccuracy: dlg.length ? mean(dlg.map((x) => x.correct)) : null,
    errors: r.filter((x) => x.error).length,
  };
}

/** Paired deltas (arm minus baseline) over probes present in both arms. */
export function pairedDeltas(
  rows: ResultRow[],
  arm: Arm,
  baseline: Arm,
  pick: (r: ResultRow) => number,
  filter: (r: ResultRow) => boolean = () => true,
): number[] {
  const base = new Map(
    rows.filter((r) => r.arm === baseline && filter(r)).map((r) => [`${r.model}|${r.probeId}`, r]),
  );
  const out: number[] = [];
  for (const r of rows) {
    if (r.arm !== arm || !filter(r)) {
      continue;
    }
    const b = base.get(`${r.model}|${r.probeId}`);
    if (b) {
      out.push(pick(r) - pick(b));
    }
  }
  return out;
}

export function renderReport(params: {
  rows: ResultRow[];
  probes: Probe[];
  cuts: number;
  spendTotal: number;
  spendByFeature: Array<[string, number]>;
  notes: string[];
  /** Pre-rendered markdown sections appended after the probe mix (e.g. the negative-probe audit). */
  extraSections?: string[];
  date: string;
}): string {
  const { rows } = params;
  const models = [...new Set(rows.map((r) => r.model))];
  const lines: string[] = [];
  lines.push(`# Compaction policy evaluation (PLAN-52A Phase E), ${params.date}`);
  lines.push("");
  lines.push(
    `Rows: ${rows.length}. Probes: ${params.probes.length}. Cuts: ${params.cuts}. Spend: $${params.spendTotal.toFixed(2)}.`,
  );
  lines.push("");
  for (const note of params.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  for (const model of models) {
    const mrows = rows.filter((r) => r.model === model);
    lines.push(`## Session model ${model}`);
    lines.push("");
    lines.push(
      "| Arm | n | accuracy | partial | abstain | hallucination (neg) | tool-output acc | dialogue acc | reach | cost p50 | cost p95 | latency p50 | latency p95 | input mean | cache read mean | errors |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const arm of [1, 2, 3, 4, 5] as Arm[]) {
      const s = summarizeArm(mrows, arm);
      if (!s.n) {
        continue;
      }
      lines.push(
        `| ${arm} ${ARM_NAMES[arm]} | ${s.n} | ${pct(s.accuracy)} | ${pct(s.partial)} | ${pct(s.abstain)} | ${pct(s.hallucination)} (n=${s.negatives}) | ${s.toolOutputAccuracy === null ? "n/a" : pct(s.toolOutputAccuracy)} | ${s.dialogueAccuracy === null ? "n/a" : pct(s.dialogueAccuracy)} | ${s.reachRate === null ? "n/a" : pct(s.reachRate)} | $${s.costMedian.toFixed(4)} | $${s.costP95.toFixed(4)} | ${(s.latencyP50 / 1000).toFixed(1)}s | ${(s.latencyP95 / 1000).toFixed(1)}s | ${Math.round(s.inputMean)} | ${Math.round(s.cacheReadMean)} | ${s.errors} |`,
      );
    }
    lines.push("");
    lines.push("Paired deltas vs arm 1 (summary), 95% bootstrap CI over per-probe deltas:");
    lines.push("");
    lines.push("| Arm | metric | n | mean delta | CI95 low | CI95 high |");
    lines.push("|---|---|---|---|---|---|");
    for (const arm of [2, 3, 4, 5] as Arm[]) {
      const acc = pairedDeltas(
        mrows,
        arm,
        1,
        (r) => r.correct,
        (r) => r.probeType !== "negative",
      );
      if (acc.length) {
        const ci = bootstrapMeanCi(acc, { iterations: 2000 });
        lines.push(
          `| ${arm} ${ARM_NAMES[arm]} | accuracy (non-negative) | ${ci.n} | ${ci.meanDelta.toFixed(3)} | ${ci.ci95Low.toFixed(3)} | ${ci.ci95High.toFixed(3)} |`,
        );
      }
      const tool = pairedDeltas(
        mrows,
        arm,
        1,
        (r) => r.correct,
        (r) => r.needsToolOutput,
      );
      if (tool.length) {
        const ci = bootstrapMeanCi(tool, { iterations: 2000 });
        lines.push(
          `| ${arm} ${ARM_NAMES[arm]} | accuracy (tool-output probes) | ${ci.n} | ${ci.meanDelta.toFixed(3)} | ${ci.ci95Low.toFixed(3)} | ${ci.ci95High.toFixed(3)} |`,
        );
      }
      const hal = pairedDeltas(
        mrows,
        arm,
        1,
        (r) => r.hallucinated,
        (r) => r.probeType === "negative",
      );
      if (hal.length) {
        const ci = bootstrapMeanCi(hal, { iterations: 2000 });
        lines.push(
          `| ${arm} ${ARM_NAMES[arm]} | hallucination (negative probes) | ${ci.n} | ${ci.meanDelta.toFixed(3)} | ${ci.ci95Low.toFixed(3)} | ${ci.ci95High.toFixed(3)} |`,
        );
      }
      const cost = pairedDeltas(mrows, arm, 1, (r) => r.costUsd);
      if (cost.length) {
        const ci = bootstrapMeanCi(cost, { iterations: 2000 });
        lines.push(
          `| ${arm} ${ARM_NAMES[arm]} | cost per probed turn (USD) | ${ci.n} | ${ci.meanDelta.toFixed(4)} | ${ci.ci95Low.toFixed(4)} | ${ci.ci95High.toFixed(4)} |`,
        );
      }
    }
    lines.push("");
  }
  lines.push("## Spend by feature");
  lines.push("");
  lines.push("| feature | USD |");
  lines.push("|---|---|");
  for (const [f, usd] of params.spendByFeature.toSorted((a, b) => b[1] - a[1])) {
    lines.push(`| ${f} | $${usd.toFixed(2)} |`);
  }
  lines.push("");
  lines.push("## Probe mix");
  lines.push("");
  const byType = new Map<string, number>();
  for (const p of params.probes) {
    byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  }
  lines.push("| type | count |");
  lines.push("|---|---|");
  for (const [t, n] of byType) {
    lines.push(`| ${t} | ${n} |`);
  }
  lines.push(`| needsToolOutput | ${params.probes.filter((p) => p.needsToolOutput).length} |`);
  lines.push(
    `| answerableFromDialogue | ${params.probes.filter((p) => p.answerableFromDialogue).length} |`,
  );
  lines.push("");
  for (const section of params.extraSections ?? []) {
    lines.push(section);
    lines.push("");
  }
  return lines.join("\n");
}
