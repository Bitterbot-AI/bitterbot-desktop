/**
 * Latent-convention twins: does verified experience fix errors the model
 * cannot avoid on its own? (Design: reports "Skill selection test data and
 * methods", 2026-11-02.)
 *
 *   node --import tsx benchmarks/skill-prior/conventions-run.ts --phase train --train-seeds 2 --yes
 *   node --import tsx benchmarks/skill-prior/conventions-run.ts --phase pilot --pilot-seeds 1
 *   node --import tsx benchmarks/skill-prior/conventions-run.ts --phase main --eval-seeds 3 --trials 1 --yes
 *
 * Phases:
 *   train  Forced-skill runs on development seeds: every variant alone in the
 *          index, once per training seed, in every workspace. Doubles as the
 *          truth table (forced right vs forced wrong). The outcome of a run
 *          that read the forced skill becomes that skill's verified record in
 *          the cell `<env>:<family>`; the treatment ledger learns the same
 *          records.
 *   pilot  Headroom gate on fresh development seeds: full index, randomized
 *          order, no card. Pre-registered pass rule: first read is a wrong
 *          variant in >= 30% of trials and pass <= 65%.
 *   main   Qualification seeds, six arms on the same instances and the same
 *          randomized order (A-D):
 *            none      no card
 *            card      verified records from training
 *            swapped   the right variant and one wrong variant exchange records
 *            placebo   same line, usage count only, no outcome
 *            prior     learned ledger order (best last), no card
 *            prior-card  learned order plus verified records
 *          Primary: card minus none on pass. Secondary (Holm): card minus
 *          placebo, card minus swapped, prior minus none, prior-card minus card.
 *
 * Records go to <out>/records.jsonl (resumable by key); journal, trial dirs
 * and ledgers live under <out> (default ~/bitterbot-skill-prior/conventions),
 * never under ~/.bitterbot.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type Candidate,
  placeRanking,
  SkillPriorLedger,
} from "../../src/agents/skills/skill-prior.js";
import { loadConfig } from "../../src/config/config.js";
import { startEventJournal } from "../../src/infra/event-journal.js";
import {
  type ArmSummary,
  type PairedContrast,
  pairedContrast,
  readCorrect,
  renderArmTable,
  renderContrasts,
  summarizeArm,
} from "./analysis.js";
import {
  clusterBootstrapCi,
  deltasByFamily,
  holm,
  recordsFromTraining,
  shuffled,
  swapRecords,
} from "./conventions-analysis.js";
import {
  CONVENTION_POOL,
  CONVENTION_POOL_NAMES,
  type ConventionInstance,
  conventionInstance,
  ENVS,
  VARIANTS,
  conventionSkillName,
} from "./conventions.js";
import {
  estimateUsd,
  makeExecutor,
  trialKey,
  type TrialRecord,
  type TrialSpec,
} from "./executor.js";
import { FAMILIES, writePool } from "./pool.js";
import { seedsIn } from "./tasks.js";

const SALT = "conventions-v1";

const { values: args } = parseArgs({
  options: {
    phase: { type: "string" },
    "train-seeds": { type: "string", default: "2" },
    "pilot-seeds": { type: "string", default: "1" },
    "eval-seeds": { type: "string", default: "3" },
    trials: { type: "string", default: "1" },
    model: { type: "string", default: "anthropic/claude-haiku-4-5" },
    out: { type: "string" },
    "ceiling-usd": { type: "string", default: "250" },
    "max-runs": { type: "string" },
    families: { type: "string" },
    envs: { type: "string" },
    arms: { type: "string" },
    "timeout-ms": { type: "string" },
    "keep-trials": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const phase = args.phase;
if (phase !== "train" && phase !== "pilot" && phase !== "main") {
  throw new Error("--phase must be train | pilot | main");
}
const families = args.families
  ? (args.families.split(",").map((f) => f.trim()) as (typeof FAMILIES)[number][])
  : [...FAMILIES];
const envs = args.envs
  ? (args.envs.split(",").map((e) => e.trim()) as (typeof ENVS)[number][])
  : [...ENVS];
const trials = Number(args.trials);
const ceilingUsd = Number(args["ceiling-usd"]);
const maxRuns = args["max-runs"] ? Number(args["max-runs"]) : Number.POSITIVE_INFINITY;
const modelTag = args.model!.replace(/^.*\//, "");
const out = path.resolve(
  args.out ?? path.join(os.homedir(), "bitterbot-skill-prior", "conventions"),
);
if (out.startsWith(path.join(os.homedir(), ".bitterbot"))) {
  throw new Error("--out must not live under ~/.bitterbot");
}
/** Phase names carry the model so a replication on another model never mixes records. */
const P = (name: string) =>
  modelTag === "claude-haiku-4-5" ? `cv-${name}` : `cv-${name}@${modelTag}`;

const hashOf = (body: string) => createHash("sha256").update(body).digest("hex");
const CANDIDATES: Candidate[] = CONVENTION_POOL.map((s) => ({
  name: s.name,
  hash: hashOf(s.body),
}));
const candidateOf = (name: string) => CANDIDATES.find((c) => c.name === name)!;

const MAIN_ARMS = ["none", "card", "swapped", "placebo", "prior", "prior-card"] as const;
type MainArm = (typeof MAIN_ARMS)[number];

const cellOf = (inst: ConventionInstance) => `${inst.env}:${inst.family}`;

function specFor(
  inst: ConventionInstance,
  p: string,
  arm: string,
  t: number,
  extra: Partial<TrialSpec>,
): TrialSpec {
  return {
    phase: p,
    arm,
    instance: inst,
    trialIndex: t,
    skills: CONVENTION_POOL_NAMES,
    pool: CONVENTION_POOL,
    correctSkill: inst.correctSkill,
    decoySkills: inst.decoySkills,
    cell: cellOf(inst),
    ...extra,
  };
}

async function loadRecords(file: string): Promise<Map<string, TrialRecord>> {
  const m = new Map<string, TrialRecord>();
  try {
    for (const line of (await fs.readFile(file, "utf-8")).split("\n")) {
      if (line.trim()) {
        const r = JSON.parse(line) as TrialRecord;
        m.set(r.key, r);
      }
    }
  } catch {
    // first run
  }
  return m;
}

const spentUsd = (rs: Iterable<TrialRecord>) => {
  let s = 0;
  for (const r of rs) {
    s += estimateUsd(r);
  }
  return s;
};

/** Which convention a run's final answer matches: "right", "wrong" (another variant) or "other". */
function answerKind(r: TrialRecord): "right" | "wrong" | "other" {
  const [env, family] = (r.cell ?? ":").split(":") as [
    (typeof ENVS)[number],
    (typeof FAMILIES)[number],
  ];
  const inst = conventionInstance(env, family, r.seed);
  const v = VARIANTS.find((x) => inst.truths[x] === (r.final ?? "").trim());
  return v === undefined ? "other" : v === inst.variant ? "right" : "wrong";
}

/** Answer table: share of final answers following the right variant, a wrong one, or none. */
function renderAnswers(groups: ReadonlyArray<[string, readonly TrialRecord[]]>): string {
  const lines = [
    "| Arm | Trials | Answer follows right variant | Follows a wrong variant | Matches no variant |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [arm, rs] of groups) {
    const withFinal = rs.filter((r) => r.final !== undefined);
    if (withFinal.length === 0) {
      continue;
    }
    const k = withFinal.map(answerKind);
    const share = (x: string) => pct(k.filter((y) => y === x).length / k.length);
    lines.push(
      `| ${arm} | ${withFinal.length} | ${share("right")} | ${share("wrong")} | ${share("other")} |`,
    );
  }
  return lines.join("\n");
}

const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  await fs.mkdir(out, { recursive: true });
  await writePool(path.join(out, "pool"), CONVENTION_POOL);
  const emptyRoot = path.join(out, "empty");
  await fs.mkdir(emptyRoot, { recursive: true });
  const recordsFile = path.join(out, "records.jsonl");
  const journal = startEventJournal({ dbPath: path.join(out, "journal.sqlite") });
  if (!journal) {
    throw new Error("event journal could not start; skill reads would be unobservable");
  }
  const records = await loadRecords(recordsFile);
  const execute = makeExecutor({
    cfg: loadConfig(),
    emptyRoot,
    trialsRoot: path.join(out, "trials"),
    modelSpec: args.model!,
    keepTrialDirs: args["keep-trials"],
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 120_000,
  });
  let runsThisSession = 0;
  const runSpec = async (spec: TrialSpec): Promise<TrialRecord> => {
    const key = trialKey(spec);
    const hit = records.get(key);
    if (hit) {
      return hit;
    }
    if (runsThisSession >= maxRuns) {
      throw new Error(`--max-runs ${maxRuns} reached`);
    }
    const spent = spentUsd(records.values());
    if (spent >= ceilingUsd) {
      throw new Error(`spend ceiling reached: $${spent.toFixed(2)} >= $${ceilingUsd}`);
    }
    let r = await execute(spec);
    for (let a = 0; a < 6 && /No available auth profile/.test(r.error ?? ""); a++) {
      process.stderr.write(`  auth profile in cooldown; waiting 90 s (attempt ${a + 1}/6)\n`);
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      r = await execute(spec);
    }
    records.set(key, r);
    runsThisSession += 1;
    await fs.appendFile(recordsFile, `${JSON.stringify(r)}\n`, "utf-8");
    process.stderr.write(
      `  ${spec.phase}/${spec.arm} ${spec.cell} s${spec.instance.seed} t${spec.trialIndex}: pass=${r.pass} read=${r.read.join("+") || "-"} ${Math.round(r.wallMs / 1000)}s $${spentUsd(records.values()).toFixed(2)}${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ""}\n`,
    );
    return r;
  };
  const confirm = (planned: number) => {
    process.stderr.write(
      `planned ${planned} trial(s); ${records.size} record(s) on disk; ceiling $${ceilingUsd}; model ${args.model}\n`,
    );
    if (planned > 200 && !args.yes) {
      throw new Error(`${planned} real turns planned (> 200); pass --yes to confirm`);
    }
  };

  const trainSeeds = seedsIn("development", 1, Number(args["train-seeds"]), SALT);
  const report: string[] = [
    `# Latent-convention test: phase ${phase}`,
    "",
    `Generated ${new Date().toISOString()}. Model ${args.model}. ${families.length} families x ${envs.length} workspaces; ${CONVENTION_POOL.length}-skill index (4 identical-description variants per family + 3 fillers). Records: ${recordsFile}.`,
    "",
  ];
  const summary: Record<string, unknown> = { phase, model: args.model, out };

  if (phase === "train") {
    const specs: TrialSpec[] = [];
    for (const seed of trainSeeds) {
      for (const env of envs) {
        for (const family of families) {
          const inst = conventionInstance(env, family, seed);
          for (const v of VARIANTS) {
            const name = conventionSkillName(family, v);
            specs.push(specFor(inst, P("train"), `forced-${v}`, 0, { skills: [name] }));
          }
        }
      }
    }
    confirm(specs.length);
    for (const spec of specs) {
      await runSpec(spec);
    }
    const rs = [...records.values()].filter((r) => r.phase === P("train"));
    const right = rs.filter((r) => r.indexOrder[0] === r.correctSkill);
    const wrong = rs.filter((r) => r.indexOrder[0] !== r.correctSkill);
    const famRows = families.map((f) => {
      const rr = right.filter((r) => r.family === f);
      const ww = wrong.filter((r) => r.family === f);
      const m = (xs: TrialRecord[]) =>
        xs.length ? xs.reduce((s, r) => s + r.pass, 0) / xs.length : null;
      const readRate = (xs: TrialRecord[]) =>
        xs.length ? xs.filter((r) => r.read.length > 0).length / xs.length : null;
      return `| ${f} | ${pct(m(rr))} (${rr.length}) | ${pct(m(ww))} (${ww.length}) | ${pct(readRate([...rr, ...ww]))} |`;
    });
    const m = (xs: TrialRecord[]) =>
      xs.length ? xs.reduce((s, r) => s + r.pass, 0) / xs.length : null;
    report.push(
      "## Truth table (forced single skill, development seeds)",
      "",
      "| Family | Right variant forced: pass | Wrong variant forced: pass | Read the skill |",
      "| --- | ---: | ---: | ---: |",
      ...famRows,
      `| **all** | ${pct(m(right))} (${right.length}) | ${pct(m(wrong))} (${wrong.length}) | ${pct(rs.filter((r) => r.read.length > 0).length / Math.max(1, rs.length))} |`,
      "",
      renderAnswers([
        ["forced right", right],
        ["forced wrong", wrong],
      ]),
      "",
      "Reading: the right variant must pass far more often than a wrong one, or the convention is not what decides the answer and the family is excluded. Runs that did not read the forced skill carry no record.",
      "",
    );
    summary.truthTable = { right: m(right), wrong: m(wrong), n: rs.length };
  }

  if (phase === "pilot") {
    const seeds = seedsIn("development", 5000, Number(args["pilot-seeds"]), SALT);
    const specs: TrialSpec[] = [];
    for (const seed of seeds) {
      for (const env of envs) {
        for (const family of families) {
          const inst = conventionInstance(env, family, seed);
          for (let t = 0; t < trials; t++) {
            specs.push(
              specFor(inst, P("pilot"), "none", t, {
                order: shuffled(CONVENTION_POOL_NAMES, `${inst.task.id}:${t}`),
              }),
            );
          }
        }
      }
    }
    confirm(specs.length);
    for (const spec of specs) {
      await runSpec(spec);
    }
    const rs = [...records.values()].filter((r) => r.phase === P("pilot"));
    const s = summarizeArm(rs)!;
    const passGate = (s.readDecoy ?? 0) >= 0.3 && (s.pass ?? 1) <= 0.65;
    report.push(
      "## Headroom gate (no card, randomized order, development seeds)",
      "",
      renderArmTable([s]),
      "",
      `Pre-registered rule: first read is a wrong variant in >= 30% of trials AND pass <= 65%. Result: wrong-variant first reads ${pct(s.readDecoy)}, pass ${pct(s.pass)}: **${passGate ? "PASS" : "FAIL"}**.`,
      "",
      "Read correct and read decoy score the FIRST skill opened.",
      "",
      renderAnswers([["none", rs]]),
      "",
    );
    summary.gate = {
      pass: s.pass,
      readDecoy: s.readDecoy,
      readCorrect: s.readCorrect,
      passed: passGate,
    };
  }

  if (phase === "main") {
    const train = [...records.values()].filter((r) => r.phase === P("train"));
    if (train.length === 0) {
      throw new Error("no training records: run --phase train first");
    }
    const evidence = recordsFromTraining(train);
    const ledger = new SkillPriorLedger();
    for (const r of train) {
      const forced = r.indexOrder.length === 1 ? r.indexOrder[0]! : null;
      if (forced && r.cell && r.error === null && r.read.includes(forced)) {
        ledger.update({
          cell: r.cell,
          skill: candidateOf(forced),
          outcome: r.pass,
          runId: r.runId,
          gate: true,
        });
      }
    }
    await fs.writeFile(path.join(out, "ledger.json"), ledger.toJSON(), "utf-8");
    await fs.writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2), "utf-8");
    const evalSeeds = seedsIn("qualification", 1, Number(args["eval-seeds"]), SALT);
    const arms = (
      args.arms ? MAIN_ARMS.filter((a) => args.arms!.split(",").includes(a)) : MAIN_ARMS
    ) as readonly MainArm[];
    // Pre-registration: the protocol is hashed before the first main run and
    // the report carries the hash; a changed protocol under the same out dir
    // is refused so a design tweak cannot be made after seeing results.
    const protocol = {
      salt: SALT,
      model: args.model,
      families,
      envs,
      evalSeeds,
      trainSeeds,
      trials,
      arms: MAIN_ARMS,
      primary: "card minus none, pass, exact sign test + family-cluster bootstrap",
      secondary: [
        "card minus placebo",
        "card minus swapped",
        "prior minus none",
        "prior-card minus card",
      ],
      correction: "Holm over the four secondary contrasts on pass",
      evidence: hashOf(JSON.stringify(evidence)),
    };
    const protoFile = path.join(out, `protocol-${P("main")}.json`);
    const protoHash = hashOf(JSON.stringify(protocol));
    try {
      const prev = JSON.parse(await fs.readFile(protoFile, "utf-8")) as { hash: string };
      if (prev.hash !== protoHash) {
        throw new Error(
          `protocol changed since the first main run (${protoFile}); use a new --out`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      await fs.writeFile(
        protoFile,
        JSON.stringify({ hash: protoHash, protocol }, null, 2),
        "utf-8",
      );
    }
    const insts: ConventionInstance[] = [];
    for (const seed of evalSeeds) {
      for (const env of envs) {
        for (const family of families) {
          insts.push(conventionInstance(env, family, seed));
        }
      }
    }
    confirm(insts.length * trials * arms.length);
    for (const inst of insts) {
      for (let t = 0; t < trials; t++) {
        const order = shuffled(CONVENTION_POOL_NAMES, `${inst.task.id}:${t}`);
        const cellEv = evidence[cellOf(inst)] ?? {};
        const priorOrder = placeRanking(
          ledger.order({ cell: cellOf(inst), candidates: CANDIDATES, mode: "mean" }).order,
          "last",
        );
        for (const arm of arms) {
          const extra: Partial<TrialSpec> =
            arm === "none"
              ? { order }
              : arm === "card"
                ? { order, evidence: cellEv }
                : arm === "swapped"
                  ? {
                      order,
                      evidence: swapRecords(
                        cellEv,
                        inst.correctSkill,
                        inst.decoySkills,
                        inst.task.id,
                      ),
                    }
                  : arm === "placebo"
                    ? { order, evidence: cellEv, evidenceStyle: "usage" as const }
                    : arm === "prior"
                      ? { order: priorOrder }
                      : { order: priorOrder, evidence: cellEv };
          await runSpec(specFor(inst, P("main"), arm, t, extra));
        }
      }
    }
    const rs = [...records.values()].filter((r) => r.phase === P("main"));
    const of = (arm: string) => rs.filter((r) => r.arm === arm);
    const summaries = arms.map((a) => summarizeArm(of(a))).filter(Boolean) as ArmSummary[];
    const pairs: Array<[MainArm, MainArm]> = [
      ["card", "none"],
      ["card", "placebo"],
      ["card", "swapped"],
      ["prior", "none"],
      ["prior-card", "card"],
      ["placebo", "none"],
      ["swapped", "none"],
    ];
    const contrasts: PairedContrast[] = [];
    const clustered: string[] = [];
    for (const metric of ["pass", "readCorrect"] as const) {
      for (const [a, b] of pairs) {
        const c = pairedContrast(of(a), of(b), metric);
        if (!c) {
          continue;
        }
        contrasts.push(c);
        const ci = clusterBootstrapCi(deltasByFamily(of(a), of(b), metric));
        if (ci) {
          clustered.push(
            `| ${a} minus ${b} | ${metric} | ${(ci.mean * 100).toFixed(1)} pp | [${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}] pp |`,
          );
        }
      }
    }
    const secondary = contrasts.filter(
      (c) =>
        c.metric === "pass" &&
        [
          ["card", "placebo"],
          ["card", "swapped"],
          ["prior", "none"],
          ["prior-card", "card"],
        ].some(([a, b]) => c.arm === a && c.baseline === b),
    );
    const adj = holm(secondary.map((c) => c.pValue ?? 1));
    // Position: where the right variant sat among its four siblings (1 = first listed).
    const posRows: string[] = [];
    for (const arm of ["none", "card"] as const) {
      const byPos = new Map<number, TrialRecord[]>();
      for (const r of of(arm)) {
        const sib = r.indexOrder.filter((n) => n === r.correctSkill || r.decoySkills?.includes(n));
        const pos = sib.indexOf(r.correctSkill!) + 1;
        byPos.set(pos, [...(byPos.get(pos) ?? []), r]);
      }
      for (const [pos, list] of [...byPos.entries()].toSorted((x, y) => x[0] - y[0])) {
        posRows.push(
          `| ${arm} | ${pos} | ${list.length} | ${pct(list.reduce((s, r) => s + r.pass, 0) / list.length)} | ${pct(list.reduce((s, r) => s + readCorrect(r), 0) / list.length)} |`,
        );
      }
    }
    // pass^k: share of instances passing on every trial.
    const passK = (arm: string) => {
      const m = new Map<string, number[]>();
      for (const r of of(arm)) {
        m.set(r.taskId, [...(m.get(r.taskId) ?? []), r.pass]);
      }
      const full = [...m.values()].filter((v) => v.length === trials);
      return full.length ? full.filter((v) => v.every((x) => x === 1)).length / full.length : null;
    };
    report.push(
      `Protocol hash ${protoHash.slice(0, 16)} (${protoFile}). Evaluation seeds ${evalSeeds.join(", ")}; ${insts.length} instances x ${trials} trial(s). Records come from ${train.length} forced training runs.`,
      "",
      "## Arms",
      "",
      renderArmTable(summaries),
      "",
      trials > 1 ? `pass^${trials}: ${arms.map((a) => `${a} ${pct(passK(a))}`).join(", ")}` : "",
      "",
      renderAnswers(arms.map((a) => [a, of(a)] as [string, TrialRecord[]])),
      "",
      "## Paired contrasts (exact sign test, instance bootstrap)",
      "",
      renderContrasts(contrasts),
      "",
      "## Family-cluster bootstrap (primary interval)",
      "",
      "| Contrast | Metric | Mean delta | 95% CI |",
      "| --- | --- | ---: | ---: |",
      ...clustered,
      "",
      "## Secondary contrasts, Holm-adjusted (pass)",
      "",
      "| Contrast | Raw p | Holm p |",
      "| --- | ---: | ---: |",
      ...secondary.map(
        (c, i) =>
          `| ${c.arm} minus ${c.baseline} | ${(c.pValue ?? 1).toFixed(4)} | ${adj[i]!.toFixed(4)} |`,
      ),
      "",
      "## Position of the right variant among its siblings",
      "",
      "| Arm | Position (1 = listed first) | Trials | Pass | First read right |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...posRows,
      "",
      "Reading: `card minus none` is the net benefit of verified records; `card minus placebo` separates content from the mere presence of a line; `card minus swapped` replicates the earlier content test; `prior minus none` asks whether the learned order alone moves the choice; `prior-card minus card` asks whether the two add. Read correct and read decoy score the FIRST skill opened.",
      "",
    );
    Object.assign(summary, { evalSeeds, summaries, contrasts, protoHash });
  }

  const spent = spentUsd(records.values());
  report.push(`Estimated spend in this output directory: $${spent.toFixed(2)} (list prices).`, "");
  const tag = P(phase);
  await fs.writeFile(path.join(out, `report-${tag}.md`), report.join("\n"), "utf-8");
  await fs.writeFile(
    path.join(out, `summary-${tag}.json`),
    `${JSON.stringify({ ...summary, spentUsd: spent }, null, 2)}\n`,
    "utf-8",
  );
  process.stdout.write(`${report.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
