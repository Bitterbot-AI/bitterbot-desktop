/**
 * PLAN-45 5.1/5.2: the skill ablation harness (one command, D-6, I10).
 *
 *   pnpm benchmark:skills [--arms none,harvested,evolved,in-context]
 *     [--corpora frozen,fresh,private,external] [--external <dir>] [--external-domains math,science]
 *     [--models primary,cheap] [--trials 3]
 *     [--cap 6 (per suite)] [--seed N] [--executor embedded|oracle]
 *     [--out docs/benchmarks/skills-<date>.md] [--fresh-context] [--yes] [--check]
 *
 * `--check` re-derives the corpus version, the exemplar pin and the node
 * state from the code and exits non-zero when the newest committed report
 * disagrees (I10). It makes no model call.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { EventJournal } from "../../src/infra/event-journal.js";
import { loadConfig } from "../../src/config/config.js";
import { getActiveEventJournal, startEventJournal } from "../../src/infra/event-journal.js";
import {
  CANONICAL_EXEMPLAR_SHA256,
  CANONICAL_GENERATOR_VERSION,
} from "../../src/memory/skill-evolution/canonical-corpus.js";
import { CONFIG_DIR } from "../../src/utils.js";
import { listLiveSkillOrigins, resolveArms } from "./ablation/arms.js";
import { resolveCorpora } from "./ablation/corpora.js";
import { makeEmbeddedExecutor, makeOracleExecutor, resolveModels } from "./ablation/executors.js";
import {
  ARM_IDS,
  type ArmId,
  type ArmKind,
  CORPUS_IDS,
  type CorpusId,
  MODEL_IDS,
  type ModelId,
  planTrials,
  type ResolvedModel,
} from "./ablation/plan.js";
import {
  HARNESS_VERSION,
  parseReportHeader,
  renderReport,
  type ReportHeader,
} from "./ablation/report.js";
import { armStats, pairedStats, type TrialRecord } from "./ablation/stats.js";

function list<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T[],
): T[] {
  if (!raw) {
    return fallback;
  }
  const out: T[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim() as T;
    if (!allowed.includes(v)) {
      throw new Error(`unknown value "${v}"; allowed: ${allowed.join(", ")}`);
    }
    out.push(v);
  }
  return out;
}

export interface RunOptions {
  arms: ArmKind[];
  corpora: CorpusId[];
  models: ModelId[];
  trials: number;
  cap: number;
  seed: number;
  executor: "embedded" | "oracle";
  out: string | null;
  freshContext: boolean;
  configDir?: string;
  argv: string[];
  /** PLAN-45 5.5: ContinualSkillBench checkout for the `external` corpus. */
  externalDir?: string;
  externalDomains?: string[];
  /** Test override for the in-context arm's journal. */
  journal?: EventJournal | null;
  /** Skip the trial-count confirmation (CI / tests). */
  yes?: boolean;
}

/** Above this many real turns the embedded executor needs --yes. */
export const CONFIRM_TRIALS_ABOVE = 200;

export async function runAblation(
  opts: RunOptions,
): Promise<{ markdown: string; header: ReportHeader; records: TrialRecord[] }> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  if (
    opts.executor === "oracle" &&
    opts.out &&
    /(^|\/)docs\/benchmarks\//.test(opts.out.replace(/\\/g, "/"))
  ) {
    throw new Error(
      "the oracle executor never writes under docs/benchmarks (its numbers are not evidence)",
    );
  }
  const cfg = opts.executor === "embedded" ? loadConfig() : ({} as ReturnType<typeof loadConfig>);
  const journal =
    opts.journal !== undefined
      ? opts.journal
      : (getActiveEventJournal() ??
        (opts.executor === "embedded" || opts.arms.includes("in-context")
          ? startEventJournal()
          : null));
  const live = await listLiveSkillOrigins(configDir);
  const { arms, icl } = await resolveArms({
    ids: opts.arms,
    configDir,
    journal,
    fresh: opts.freshContext,
    live,
  });
  const corpora = await resolveCorpora({
    ids: opts.corpora,
    seed: opts.seed,
    configDir,
    ...(opts.externalDir ? { externalDir: opts.externalDir } : {}),
    ...(opts.externalDomains?.length ? { externalDomains: opts.externalDomains } : {}),
  });
  const models: ResolvedModel[] =
    opts.executor === "embedded"
      ? resolveModels(cfg, opts.models)
      : opts.models.map((id) => ({ id, spec: `oracle/${id}` }));
  const trials = planTrials({ arms, corpora, models, trialsPerTask: opts.trials, cap: opts.cap });
  const measuredArms = new Set(trials.filter((t) => t.arm !== "none").map((t) => t.arm));
  if (opts.executor === "embedded" && measuredArms.size === 0) {
    throw new Error(
      `nothing to measure: no non-baseline arm has a skill on this node (${arms.map((a) => `${a.id}: ${a.note ?? a.skillNames.length}`).join("; ")})`,
    );
  }
  for (const corpus of corpora) {
    if (measuredArms.size > 0 && !corpus.tasks.some((t) => t.suite !== "regression")) {
      throw new Error(
        `corpus ${corpus.id} has no capability task; a paired comparison would have n=0`,
      );
    }
  }
  process.stderr.write(
    `planned ${trials.length} trial(s): arms ${arms.map((a) => a.id).join(",")}; corpora ${corpora.map((c) => `${c.id}=${c.tasks.length}`).join(",")}; models ${models.map((m) => m.spec).join(",")}\n`,
  );
  if (opts.executor === "embedded" && trials.length > CONFIRM_TRIALS_ABOVE && !opts.yes) {
    throw new Error(
      `${trials.length} real turns planned (> ${CONFIRM_TRIALS_ABOVE}); pass --yes to confirm, or lower --cap / --trials / --models`,
    );
  }
  const execute =
    opts.executor === "oracle"
      ? makeOracleExecutor(opts.seed)
      : makeEmbeddedExecutor({ cfg, configDir });
  const records: TrialRecord[] = [];
  for (const trial of trials) {
    const arm = arms.find((a) => a.id === trial.arm);
    const model = models.find((m) => m.id === trial.model);
    if (!arm || !model) {
      continue;
    }
    records.push(await execute(trial, arm, model));
    if (records.length % 10 === 0) {
      process.stderr.write(`  ${records.length}/${trials.length} trials\n`);
    }
  }
  const stats = [];
  const paired = [];
  for (const model of models) {
    for (const corpus of corpora) {
      const of = (arm: ArmId) =>
        records.filter((r) => r.arm === arm && r.corpus === corpus.id && r.model === model.id);
      for (const arm of arms) {
        const s = armStats(of(arm.id), opts.trials);
        if (s) {
          stats.push(s);
        }
      }
      const baseline = of("none");
      for (const arm of arms) {
        if (arm.id === "none") {
          continue;
        }
        const p = pairedStats(of(arm.id), baseline);
        if (p) {
          paired.push(p);
        }
      }
      // 5.2: each evolved skill against its OWN in-context control.
      for (const arm of arms) {
        if (!arm.id.startsWith("evolved:")) {
          continue;
        }
        const p = pairedStats(of(arm.id), of(`in-context:${arm.id.slice("evolved:".length)}`));
        if (p) {
          paired.push(p);
        }
      }
    }
  }
  const privateCorpus = corpora.find((c) => c.id === "private");
  const reportDate = opts.out?.match(/skills-(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  const header: ReportHeader = {
    harnessVersion: HARNESS_VERSION,
    generatedAt: new Date().toISOString(),
    ...(reportDate ? { reportDate } : {}),
    argv: opts.argv,
    executor: opts.executor,
    generatorVersion: CANONICAL_GENERATOR_VERSION,
    exemplarSha256: CANONICAL_EXEMPLAR_SHA256,
    seed: opts.seed,
    cap: opts.cap,
    trials: opts.trials,
    corpusVersions: Object.fromEntries(corpora.map((c) => [c.id, c.version])),
    models: Object.fromEntries(models.map((m) => [m.id, m.spec])),
    arms: Object.fromEntries(arms.map((a) => [a.id, a.skillNames])),
    nodeState: {
      live: live.length,
      evolved: live.filter((s) => s.origin === "evolved").length,
      harvested: live.filter((s) => s.origin === "harvested").length,
      privateTasks: privateCorpus?.tasks.length ?? 0,
    },
  };
  const caveats = [
    `n is small: the canonical corpus carries 9 capability tasks per seed; a paired test below 5 tasks makes no claim.`,
    `The labeler's real-trace calibration accuracy is 0.52 on a stratified sample with rater B pending (benchmarks/skill-evolution/README.md); task checkers here are deterministic, so that does not affect these numbers, but it bounds what the live loop can learn from.`,
    opts.executor === "oracle"
      ? `Executor: ORACLE (deterministic, keyless). These numbers exercise the harness, not a model.`
      : `Executor: embedded runs on ${Object.values(header.models).join(" and ")}; one node, one day.`,
  ];
  const markdown = renderReport({ header, arms, corpora, models, stats, paired, icl, caveats });
  if (opts.out) {
    const out = opts.out.endsWith(".md") ? opts.out : `${opts.out}.md`;
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, markdown, "utf-8");
    await fs.writeFile(
      out.replace(/\.md$/, ".json"),
      `${JSON.stringify({ header, stats, paired, records }, null, 2)}\n`,
      "utf-8",
    );
  }
  return { markdown, header, records };
}

/** I10: the newest committed report must match the code's corpus version and pin. */
export async function checkCommittedReport(
  dir: string,
  configDir?: string,
): Promise<{ ok: boolean; detail: string }> {
  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => /^skills-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .toSorted();
  } catch {
    return { ok: false, detail: `${dir} does not exist` };
  }
  const newest = files.at(-1);
  if (!newest) {
    return { ok: false, detail: `no skills-<date>.md report under ${dir}` };
  }
  const header = parseReportHeader(await fs.readFile(path.join(dir, newest), "utf-8"));
  if (!header) {
    return { ok: false, detail: `${newest}: no header block` };
  }
  const problems: string[] = [];
  // A committed report is EVIDENCE: it came from real turns on the frozen corpus.
  if (header.executor !== "embedded") {
    problems.push(`executor ${header.executor} (a committed report must be embedded)`);
  }
  if (!header.corpusVersions.frozen) {
    problems.push("no frozen corpus cell");
  }
  if (header.generatorVersion !== CANONICAL_GENERATOR_VERSION) {
    problems.push(`generatorVersion ${header.generatorVersion} != ${CANONICAL_GENERATOR_VERSION}`);
  }
  if (header.exemplarSha256 !== CANONICAL_EXEMPLAR_SHA256) {
    problems.push(
      `exemplarSha256 ${header.exemplarSha256.slice(0, 12)} != ${CANONICAL_EXEMPLAR_SHA256.slice(0, 12)}`,
    );
  }
  const corpora = await resolveCorpora({
    ids: ["frozen"],
    seed: 0,
    ...(configDir ? { configDir } : {}),
  });
  const frozen = corpora[0]?.version;
  if (header.corpusVersions.frozen && frozen && header.corpusVersions.frozen !== frozen) {
    problems.push(`frozen corpus ${header.corpusVersions.frozen} != ${frozen}`);
  }
  if (header.harnessVersion !== HARNESS_VERSION) {
    problems.push(`harnessVersion ${header.harnessVersion} != ${HARNESS_VERSION}`);
  }
  return problems.length === 0
    ? {
        ok: true,
        detail: `${newest} matches generator ${CANONICAL_GENERATOR_VERSION}, exemplar ${CANONICAL_EXEMPLAR_SHA256.slice(0, 12)}`,
      }
    : { ok: false, detail: `${newest}: ${problems.join("; ")}` };
}

async function main(): Promise<void> {
  // pnpm 10 forwards a literal `--` to the script (adversarial 5-1).
  const argv = process.argv.slice(2).filter((a, i) => !(a === "--" && i === 0));
  const { values } = parseArgs({
    args: argv,
    options: {
      arms: { type: "string" },
      corpora: { type: "string" },
      models: { type: "string" },
      trials: { type: "string", default: "3" },
      cap: { type: "string" },
      seed: { type: "string" },
      executor: { type: "string", default: "embedded" },
      out: { type: "string" },
      "fresh-context": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "report-dir": { type: "string", default: "docs/benchmarks" },
      yes: { type: "boolean", default: false },
      external: { type: "string" },
      "external-domains": { type: "string" },
    },
    strict: true,
  });
  if (values.check) {
    const r = await checkCommittedReport(values["report-dir"] ?? "docs/benchmarks");
    process.stdout.write(`${r.ok ? "OK" : "MISMATCH"}: ${r.detail}\n`);
    process.exit(r.ok ? 0 : 1);
  }
  const executor = values.executor === "oracle" ? "oracle" : "embedded";
  const date = new Date().toISOString().slice(0, 10);
  const result = await runAblation({
    arms: list(values.arms, ARM_IDS, [...ARM_IDS]),
    corpora: list(values.corpora, CORPUS_IDS, ["frozen", "fresh", "private"]),
    // Defaults are the affordable run: the primary model, six tasks per suite.
    models: list(values.models, MODEL_IDS, ["primary"]),
    // `external` is opt-in: it needs a checkout.
    trials: Math.max(1, Number(values.trials) || 3),
    cap: values.cap === undefined ? 6 : Math.max(0, Number(values.cap) || 0),
    seed: values.seed ? Number(values.seed) >>> 0 : 0,
    executor,
    out: values.out === "/dev/null" ? null : (values.out ?? `docs/benchmarks/skills-${date}.md`),
    freshContext: values["fresh-context"] === true,
    argv,
    yes: values.yes === true,
    ...(values.external ? { externalDir: values.external } : {}),
    ...(values["external-domains"]
      ? { externalDomains: values["external-domains"].split(",").map((d) => d.trim()) }
      : {}),
  });
  if (!values.out || values.out === "/dev/null") {
    process.stdout.write(result.markdown);
  } else {
    process.stdout.write(`wrote ${values.out} (${result.records.length} trials)\n`);
  }
  // The embedded runtime leaves timers behind (journal, providers); the
  // report is on disk, so leave explicitly.
  process.exit(0);
}

if (process.argv[1] && /ablation\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
