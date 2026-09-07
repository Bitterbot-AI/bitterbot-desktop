/**
 * PLAN-45 5.1 (D-6, I10): the committed report. Lint-clean markdown with a
 * machine-readable header the `--check` mode verifies against the code's
 * corpus version and the exemplar pin. The verdict sentences are fixed in
 * advance (5.2): a tie or a loss is stated, never softened.
 */

import type { IclContext } from "../../../src/memory/skill-evolution/icl-context.js";
import type {
  ArmId,
  CorpusId,
  ModelId,
  ResolvedArm,
  ResolvedCorpus,
  ResolvedModel,
} from "./plan.js";
import type { ArmStats, PairedStats } from "./stats.js";
import { exactSignTest } from "../../../src/memory/skill-evolution/sign-test.js";

export const HARNESS_VERSION = 1;

export interface ReportHeader {
  harnessVersion: number;
  generatedAt: string;
  /** The date in the report's file name (local), when written to a dated file. */
  reportDate?: string;
  argv: string[];
  executor: string;
  generatorVersion: number;
  exemplarSha256: string;
  seed: number;
  cap: number;
  trials: number;
  corpusVersions: Record<string, string>;
  models: Record<string, string>;
  arms: Record<string, string[]>;
  nodeState: { live: number; evolved: number; harvested: number; privateTasks: number };
}

export interface ReportInput {
  header: ReportHeader;
  arms: ResolvedArm[];
  corpora: ResolvedCorpus[];
  models: ResolvedModel[];
  stats: ArmStats[];
  paired: PairedStats[];
  icl: IclContext[];
  caveats: string[];
}

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(0)}%`);
const num = (v: number | null, d = 3) => (v === null ? "n/a" : v.toFixed(d));
const signed = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`);

/** One-sided p for "arm worse than baseline" (pairedStats tests the other direction). */
function reverseP(p: PairedStats): number {
  const deltas: number[] = [
    ...Array<number>(p.losses).fill(1),
    ...Array<number>(p.wins).fill(-1),
    ...Array<number>(p.ties).fill(0),
  ];
  return exactSignTest(deltas).pValue;
}

export function verdictSentence(p: PairedStats): string {
  const who = p.arm.startsWith("in-context") ? "the in-context control" : `the ${p.arm} arm`;
  const vs = p.baseline.startsWith("in-context")
    ? "the in-context control"
    : `the ${p.baseline} arm`;
  if (p.n < 5) {
    return `Underpowered: ${p.n} paired task(s) between ${who} and ${vs}; no claim is made.`;
  }
  const ci = `95% CI [${num(p.ci95Low, 2)}, ${num(p.ci95High, 2)}]`;
  const credited = `credited (skill read) ${p.credited.wins}/${p.credited.losses}/${p.credited.ties}, p=${num(p.credited.pValue, 3)}`;
  if (p.pValue !== null && p.pValue < 0.05 && (p.meanDelta ?? 0) > 0) {
    return `${who} beat ${vs}: ${p.wins} wins, ${p.losses} losses over ${p.n} tasks (p=${num(p.pValue, 4)}, ${ci}); ${credited}; token delta ${signed(p.tokenDelta)}.`;
  }
  const rp = reverseP(p);
  if (rp < 0.05 && (p.meanDelta ?? 0) < 0) {
    return `${who} LOST to ${vs}: ${p.losses} losses, ${p.wins} wins over ${p.n} tasks (reverse p=${num(rp, 4)}, ${ci}); on this evidence ${p.baseline.startsWith("in-context") ? "the skill abstraction is not carrying its weight" : `${vs} is ahead`}; token delta ${signed(p.tokenDelta)}.`;
  }
  // Neither direction is significant. Only a CI that excludes a material
  // effect either way (10 points) supports "equivalent"; otherwise the
  // honest word is inconclusive.
  const tight = p.ci95Low !== null && p.ci95High !== null && p.ci95Low > -0.1 && p.ci95High < 0.1;
  const reproduces =
    p.arm.startsWith("evolved") && p.baseline.startsWith("in-context")
      ? tight
        ? " This reproduces the ContinualSkillBench finding (in-context 0.605 vs skill library 0.602) on this node's corpus; the skill's remaining claim is cost and persistence, not accuracy."
        : " The comparison with the in-context control is inconclusive at this n."
      : "";
  return `${who} did not ${tight ? "differ from" : "measurably beat"} ${vs} (${p.wins}/${p.losses}/${p.ties} W/L/T over ${p.n} tasks, delta ${signed(p.meanDelta)}, p=${num(p.pValue, 3)}, ${ci}); ${tight ? "equivalent on this suite" : "inconclusive"}.${reproduces} Token delta ${signed(p.tokenDelta)}; ${credited}.`;
}

/** Markdown table with padded columns (oxfmt-stable). */
function table(header: string[], align: Array<"l" | "r">, rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, 3, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells
      .map((c, i) => (align[i] === "r" ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join(" | ")} |`;
  const sep = `| ${widths
    .map((w, i) => (align[i] === "r" ? `${"-".repeat(w - 1)}:` : "-".repeat(w)))
    .join(" | ")} |`;
  return [line(header), sep, ...rows.map(line)];
}

function cell(
  stats: ArmStats[],
  arm: ArmId,
  corpus: CorpusId,
  model: ModelId,
): ArmStats | undefined {
  return stats.find((s) => s.arm === arm && s.corpus === corpus && s.model === model);
}

export function renderReport(input: ReportInput): string {
  const h = input.header;
  const lines: string[] = [];
  lines.push(`# Skill ablation ${h.reportDate ?? h.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(
    "PLAN-45 Phase 5.1/5.2. Regenerate with the command in the header; `--check` verifies this report against the committed corpus version.",
  );
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(h, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Node state");
  lines.push("");
  lines.push(
    `- Live skills: ${h.nodeState.live} (evolved ${h.nodeState.evolved}, harvested ${h.nodeState.harvested}); private capability tasks: ${h.nodeState.privateTasks}.`,
  );
  for (const a of input.arms) {
    if (a.note) {
      lines.push(`- Arm \`${a.id}\`: ${a.note}.`);
    }
  }
  for (const c of input.corpora) {
    if (c.note) {
      lines.push(`- Corpus \`${c.id}\`: ${c.note}.`);
    }
  }
  for (const ctx of input.icl) {
    lines.push(
      `- In-context control for \`${ctx.skillName}\`: ${ctx.renderedRunIds.length}/${ctx.runIds.length} evidence runs rendered (${ctx.chars} chars${ctx.missingRunIds.length ? `, missing ${ctx.missingRunIds.join(", ")}` : ""}${ctx.droppedRunIds.length ? `, dropped ${ctx.droppedRunIds.length} for budget` : ""}; journal seq ${ctx.journalMaxSeq}).`,
    );
  }
  lines.push("");
  lines.push("## Results");
  lines.push("");
  for (const model of input.models) {
    for (const corpus of input.corpora) {
      lines.push(`### ${model.id} (${model.spec}) on ${corpus.id} (${corpus.version})`);
      lines.push("");
      const rows: string[][] = [];
      for (const arm of input.arms) {
        const s = cell(input.stats, arm.id, corpus.id, model.id);
        if (!s) {
          continue;
        }
        rows.push([
          arm.id,
          String(s.tasks),
          String(s.trials),
          pct(s.passAt1),
          `${pct(s.passPowK)} (K=${s.k})`,
          pct(s.readRate),
          String(s.tokens),
          String(s.errors),
        ]);
      }
      if (rows.length === 0) {
        rows.push(["(no trials)", "", "", "", "", "", "", ""]);
      }
      lines.push(
        ...table(
          ["Arm", "Tasks", "Trials", "pass@1", "pass^K", "Read rate", "Tokens", "Errors"],
          ["l", "r", "r", "r", "r", "r", "r", "r"],
          rows,
        ),
      );
      lines.push("");
      const pairs = input.paired.filter((p) => p.corpus === corpus.id && p.model === model.id);
      if (pairs.length > 0) {
        lines.push(
          ...table(
            [
              "Comparison",
              "n",
              "W/L/T",
              "p",
              "Mean delta",
              "95% CI",
              "Credited W/L/T",
              "Token delta",
            ],
            ["l", "r", "r", "r", "r", "r", "r", "r"],
            pairs.map((p) => [
              `${p.arm} vs ${p.baseline}`,
              String(p.n),
              `${p.wins}/${p.losses}/${p.ties}`,
              num(p.pValue, 4),
              signed(p.meanDelta),
              `[${num(p.ci95Low, 2)}, ${num(p.ci95High, 2)}]`,
              `${p.credited.wins}/${p.credited.losses}/${p.credited.ties}`,
              signed(p.tokenDelta),
            ]),
          ),
        );
        lines.push("");
        for (const p of pairs) {
          lines.push(`- ${verdictSentence(p)}`);
        }
        lines.push("");
      }
    }
  }
  // Memorization telemetry: frozen minus fresh per arm.
  const frozenFresh: string[] = [];
  for (const model of input.models) {
    for (const arm of input.arms) {
      const f = cell(input.stats, arm.id, "frozen", model.id);
      const r = cell(input.stats, arm.id, "fresh", model.id);
      if (
        f?.passAt1 !== null &&
        f?.passAt1 !== undefined &&
        r?.passAt1 !== null &&
        r?.passAt1 !== undefined
      ) {
        frozenFresh.push(
          `- ${model.id} / ${arm.id}: frozen ${pct(f.passAt1)} vs fresh ${pct(r.passAt1)} (gap ${signed(f.passAt1 - r.passAt1)}).`,
        );
      }
    }
  }
  if (frozenFresh.length > 0) {
    lines.push("## Exemplar versus fresh seed (memorization telemetry)");
    lines.push("");
    lines.push(...frozenFresh);
    lines.push("");
  }
  lines.push("## Caveats");
  lines.push("");
  // A baseline at ceiling leaves no headroom: say so before any reader
  // takes an "equivalent" verdict as evidence about the skills.
  for (const s of input.stats) {
    if (s.arm === "none" && s.passAt1 !== null && s.passAt1 >= 0.95) {
      lines.push(
        `- ${s.model} on ${s.corpus}: the baseline passes ${pct(s.passAt1)} of the capped suite; the suite is at ceiling for this model and cannot show a skill's benefit (the gate's per-model calibration drops such families for the same reason).`,
      );
    }
  }
  for (const c of input.caveats) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The header block of a committed report, or null. */
export function parseReportHeader(markdown: string): ReportHeader | null {
  const m = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!m) {
    return null;
  }
  try {
    return JSON.parse(m[1] ?? "") as ReportHeader;
  } catch {
    return null;
  }
}
