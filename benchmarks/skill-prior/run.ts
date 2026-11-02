/**
 * Experience-guided skill prior: the controlled test.
 *
 *   node --import tsx benchmarks/skill-prior/run.ts --phase order    --seeds 4 --trials 2
 *   node --import tsx benchmarks/skill-prior/run.ts --phase headroom --seeds 4 --trials 1
 *   node --import tsx benchmarks/skill-prior/run.ts --phase arms --learn-seeds 6 --eval-seeds 4 --trials 2
 *
 * Phases (each an abort gate for the next, see docs/memory/skills-pipeline.md):
 *   order     Does the model's first SKILL.md read depend on index position?
 *             Same pool, correct skill first vs last with its decoy adjacent.
 *   headroom  Forced-skill truth table: no skill / correct alone / decoy
 *             alone per instance. Oracle minus baseline is the room a
 *             reranker has; decoy harm is what mis-ordering costs.
 *   arms      Learn on development seeds with Thompson ordering and gated
 *             updates (treatment, context-free global, and ungated
 *             co-occurrence ledgers fed the SAME episodes), freeze, then
 *             evaluate on qualification seeds: baseline, global, prior,
 *             shuffled, ungated.
 *
 * Every real turn is logged to <out>/records.jsonl (resumable by key); the
 * journal, pool, trial dirs and ledgers live under <out>, never under
 * ~/.bitterbot. Spend is estimated from token usage at list prices and the
 * run stops at --ceiling-usd.
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
  type SkillPriorMode,
  type SkillPriorPlacement,
} from "../../src/agents/skills/skill-prior.js";
import { loadConfig } from "../../src/config/config.js";
import { startEventJournal } from "../../src/infra/event-journal.js";
import {
  type ArmSummary,
  headroom as computeHeadroom,
  type PairedContrast,
  pairedContrast,
  renderArmTable,
  renderContrasts,
  renderHeadroom,
  summarizeArm,
} from "./analysis.js";
import {
  estimateUsd,
  makeExecutor,
  trialKey,
  type TrialRecord,
  type TrialSpec,
} from "./executor.js";
import { FAMILIES, POOL, POOL_NAMES, poolByFamily, writePool } from "./pool.js";
import {
  applyVariant,
  type Instance,
  instancesForSeed,
  seedsIn,
  type TaskVariant,
} from "./tasks.js";

const { values: args } = parseArgs({
  options: {
    phase: { type: "string" },
    seeds: { type: "string", default: "4" },
    "learn-seeds": { type: "string", default: "6" },
    "eval-seeds": { type: "string", default: "4" },
    trials: { type: "string", default: "2" },
    model: { type: "string", default: "anthropic/claude-haiku-4-5" },
    out: { type: "string" },
    "ceiling-usd": { type: "string", default: "25" },
    "max-runs": { type: "string" },
    families: { type: "string" },
    "keep-trials": { type: "boolean", default: false },
    "timeout-ms": { type: "string" },
    placement: { type: "string", default: "last" },
    variant: { type: "string", default: "specified" },
    "eval-arms": { type: "string" },
    yes: { type: "boolean", default: false },
  },
});

const basePhase = args.phase;
if (basePhase !== "order" && basePhase !== "headroom" && basePhase !== "arms") {
  throw new Error("--phase must be order | headroom | arms");
}
const VARIANT: TaskVariant = args.variant === "underspecified" ? "underspecified" : "specified";
/** Records and reports are keyed by phase + variant so the two task shapes never mix. */
const phase =
  (VARIANT === "underspecified" ? `${basePhase}-u` : basePhase) +
  (basePhase === "arms" && args.placement === "first" ? "-pf" : "");
const learnPhase = VARIANT === "underspecified" ? "learn-u" : "learn";
const instances = (seed: number) => applyVariant(instancesForSeed(seed, families), VARIANT);
const trials = Number(args.trials);
const ceilingUsd = Number(args["ceiling-usd"]);
const maxRuns = args["max-runs"] ? Number(args["max-runs"]) : Number.POSITIVE_INFINITY;
const families = args.families
  ? (args.families.split(",").map((f) => f.trim()) as (typeof FAMILIES)[number][])
  : [...FAMILIES];
const PLACEMENT: SkillPriorPlacement = args.placement === "first" ? "first" : "last";
const out = path.resolve(args.out ?? path.join(os.homedir(), "bitterbot-skill-prior"));
if (out.startsWith(path.join(os.homedir(), ".bitterbot"))) {
  throw new Error("--out must not live under ~/.bitterbot");
}

const hashOf = (body: string) => createHash("sha256").update(body).digest("hex");
const CANDIDATES: Record<string, Candidate> = Object.fromEntries(
  POOL.map((s) => [s.name, { name: s.name, hash: hashOf(s.body) }]),
);

async function loadRecords(file: string): Promise<Map<string, TrialRecord>> {
  const m = new Map<string, TrialRecord>();
  try {
    const raw = await fs.readFile(file, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const r = JSON.parse(line) as TrialRecord;
      m.set(r.key, r);
    }
  } catch {
    // first run
  }
  return m;
}

function spentUsd(records: Iterable<TrialRecord>): number {
  let s = 0;
  for (const r of records) {
    s += estimateUsd(r);
  }
  return s;
}

/** Full-pool index with the family's correct skill placed first or last (decoy adjacent). */
function orderFor(instance: Instance, where: "first" | "last"): string[] {
  const { correct, decoy } = poolByFamily(instance.family);
  const rest = POOL_NAMES.filter((n) => n !== correct.name && n !== decoy.name);
  return where === "first"
    ? [correct.name, decoy.name, ...rest]
    : [...rest, decoy.name, correct.name];
}

async function main(): Promise<void> {
  await fs.mkdir(out, { recursive: true });
  await writePool(path.join(out, "pool")); // reference copy of the pool for the record
  const emptyRoot = path.join(out, "empty");
  await fs.mkdir(emptyRoot, { recursive: true });
  const trialsRoot = path.join(out, "trials");
  const recordsFile = path.join(out, "records.jsonl");
  const journal = startEventJournal({ dbPath: path.join(out, "journal.sqlite") });
  if (!journal) {
    throw new Error("event journal could not start; skill reads would be unobservable");
  }
  const cfg = loadConfig();
  const records = await loadRecords(recordsFile);
  const execute = makeExecutor({
    cfg,
    emptyRoot,
    trialsRoot,
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
    // A run-level timeout makes the embedded runner put the (single) auth
    // profile into cooldown; wait it out instead of burning every trial that
    // follows. Nothing is recorded for a cooldown failure.
    let r = await execute(spec);
    for (
      let attempt = 0;
      attempt < 6 && /No available auth profile/.test(r.error ?? "");
      attempt++
    ) {
      process.stderr.write(`  auth profile in cooldown; waiting 90 s (attempt ${attempt + 1}/6)\n`);
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      r = await execute(spec);
    }
    records.set(key, r);
    runsThisSession += 1;
    await fs.appendFile(recordsFile, `${JSON.stringify(r)}\n`, "utf-8");
    process.stderr.write(
      `  ${spec.phase}/${spec.arm} ${spec.instance.family} s${spec.instance.seed} t${spec.trialIndex}: pass=${r.pass} read=${r.read.join("+") || "-"} ${Math.round(r.wallMs / 1000)}s $${spentUsd(records.values()).toFixed(2)}${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ""}\n`,
    );
    return r;
  };

  const report: string[] = [
    `# Skill prior test: phase ${phase}`,
    "",
    `Generated ${new Date().toISOString()}. Model ${args.model}. Task variant ${VARIANT}; placement ${PLACEMENT}. Pool of ${POOL.length} skills (${FAMILIES.length} correct, ${FAMILIES.length} decoys, ${POOL.length - 2 * FAMILIES.length} fillers). Records: ${recordsFile}.`,
    "",
  ];
  const summary: Record<string, unknown> = {
    phase,
    variant: VARIANT,
    placement: PLACEMENT,
    model: args.model,
    out,
  };

  if (basePhase === "order") {
    const seeds = seedsIn("development", 1, Number(args.seeds));
    const specs: TrialSpec[] = [];
    for (const seed of seeds) {
      for (const instance of instances(seed)) {
        for (let t = 0; t < trials; t++) {
          for (const where of ["first", "last"] as const) {
            specs.push({
              phase,
              arm: `correct-${where}`,
              instance,
              trialIndex: t,
              skills: POOL_NAMES,
              order: orderFor(instance, where),
            });
          }
        }
      }
    }
    await confirm(specs.length, records);
    for (const spec of specs) {
      await runSpec(spec);
    }
    const rs = [...records.values()].filter((r) => r.phase === phase);
    const first = rs.filter((r) => r.arm === "correct-first");
    const last = rs.filter((r) => r.arm === "correct-last");
    const summaries = [summarizeArm(first), summarizeArm(last)].filter(Boolean) as ArmSummary[];
    const contrasts = [
      pairedContrast(first, last, "readCorrect"),
      pairedContrast(first, last, "pass"),
    ].filter(Boolean) as PairedContrast[];
    report.push(
      "## Order sensitivity (Phase 0a)",
      "",
      renderArmTable(summaries),
      "",
      renderContrasts(contrasts),
      "",
    );
    report.push(
      "Reading: if `correct-first minus correct-last` on `readCorrect` has a CI that excludes zero, the index-level insertion is live; otherwise the model routes on description text alone and the interceptor mechanism must be re-registered before any treatment run.",
      "",
    );
    Object.assign(summary, { summaries, contrasts });
  }

  if (basePhase === "headroom") {
    const seeds = seedsIn("development", 1, Number(args.seeds));
    const specs: TrialSpec[] = [];
    for (const seed of seeds) {
      for (const instance of instances(seed)) {
        const { correct, decoy } = poolByFamily(instance.family);
        for (let t = 0; t < trials; t++) {
          specs.push({ phase, arm: "none", instance, trialIndex: t, skills: [] });
          specs.push({ phase, arm: "correct", instance, trialIndex: t, skills: [correct.name] });
          specs.push({ phase, arm: "decoy", instance, trialIndex: t, skills: [decoy.name] });
        }
      }
    }
    await confirm(specs.length, records);
    for (const spec of specs) {
      await runSpec(spec);
    }
    const rs = [...records.values()].filter((r) => r.phase === phase);
    const h = computeHeadroom(rs);
    const summaries = ["none", "correct", "decoy"]
      .map((arm) => summarizeArm(rs.filter((r) => r.arm === arm)))
      .filter(Boolean) as ArmSummary[];
    const none = rs.filter((r) => r.arm === "none");
    const contrasts = [
      pairedContrast(
        rs.filter((r) => r.arm === "correct"),
        none,
        "pass",
      ),
      pairedContrast(
        rs.filter((r) => r.arm === "decoy"),
        none,
        "pass",
      ),
    ].filter(Boolean) as PairedContrast[];
    report.push(
      "## Headroom (Phase 0b)",
      "",
      renderHeadroom(h),
      "",
      renderArmTable(summaries),
      "",
      renderContrasts(contrasts),
      "",
    );
    report.push(
      "Reading: headroom is the pass-rate gain when the correct skill is the only index entry; a family with no headroom cannot show a ranking effect and is excluded from the primary analysis. Decoy harm is the cost of reading the wrong skill.",
      "",
    );
    Object.assign(summary, { headroom: h, summaries, contrasts });
  }

  if (basePhase === "arms") {
    const learnSeeds = seedsIn("development", 1000, Number(args["learn-seeds"]));
    const evalSeeds = seedsIn("qualification", 1, Number(args["eval-seeds"]));
    const ledgerDir = path.join(out, "ledgers");
    await fs.mkdir(ledgerDir, { recursive: true });
    const treatment = new SkillPriorLedger();
    const global = new SkillPriorLedger();
    const ungated = new SkillPriorLedger();
    const candidates = POOL_NAMES.map((n) => CANDIDATES[n]!);
    // Learning: Thompson order from the treatment ledger; every ledger sees
    // the same (read, outcome) stream. The gate is open when exactly one
    // pool skill was read and the verifier settled the outcome (always, here).
    const learnSpecs: Array<{ instance: Instance; t: number }> = [];
    for (const seed of learnSeeds) {
      for (const instance of instances(seed)) {
        for (let t = 0; t < trials; t++) {
          learnSpecs.push({ instance, t });
        }
      }
    }
    const ALL_EVAL_ARMS = ["baseline", "global", "prior", "shuffled", "ungated"] as const;
    const evalArms = args["eval-arms"]
      ? ALL_EVAL_ARMS.filter((a) => args["eval-arms"]!.split(",").includes(a))
      : ALL_EVAL_ARMS;
    await confirm(
      learnSpecs.length + evalArms.length * evalSeeds.length * families.length * trials,
      records,
    );
    const seeded = mulberry32(0x5eed);
    const learnLog: Array<Record<string, unknown>> = [];
    for (const { instance, t } of learnSpecs) {
      const cell = instance.family;
      const ordered = treatment.order({ cell, candidates, mode: "thompson", rng: seeded });
      const r = await runSpec({
        phase: learnPhase,
        arm: "thompson",
        instance,
        trialIndex: t,
        skills: POOL_NAMES,
        order: placeRanking(ordered.order, PLACEMENT),
      });
      const read = r.read.length === 1 ? r.read[0]! : null;
      const gate = read !== null && r.error === null;
      if (read) {
        const skill = CANDIDATES[read]!;
        treatment.update({ cell, skill, outcome: r.pass, runId: r.runId, gate });
        global.update({ cell: "all", skill, outcome: r.pass, runId: r.runId, gate });
        ungated.update({ cell, skill, outcome: 1, runId: r.runId, gate: read !== null });
      }
      learnLog.push({
        taskId: r.taskId,
        family: cell,
        order: ordered.order.slice(0, 3),
        propensity: ordered.propensity ? (ordered.propensity[read ?? ""] ?? null) : null,
        read,
        pass: r.pass,
        gate,
      });
    }
    const shuffled = treatment.shuffledAcrossCells(mulberry32(0x5a5a));
    for (const [name, ledger] of [
      ["treatment", treatment],
      ["global", global],
      ["ungated", ungated],
      ["shuffled", shuffled],
    ] as const) {
      await fs.writeFile(path.join(ledgerDir, `${name}.json`), ledger.toJSON(), "utf-8");
    }
    await fs.writeFile(
      path.join(out, "learn-log.json"),
      JSON.stringify(learnLog, null, 2),
      "utf-8",
    );
    // Frozen evaluation on fresh seeds (surface transfer).
    // Phase 0a on this model: the later of two near-equivalent entries is
    // read (7/7 discordant pairs), so the ranking is placed best-LAST. The
    // learning phase placed Thompson draws the same way.
    const orderBy = (ledger: SkillPriorLedger | null, cell: string): string[] | undefined =>
      ledger
        ? placeRanking(
            ledger.order({ cell, candidates, mode: "mean" as SkillPriorMode }).order,
            PLACEMENT,
          )
        : undefined;
    for (const seed of evalSeeds) {
      for (const instance of instances(seed)) {
        for (let t = 0; t < trials; t++) {
          for (const arm of evalArms) {
            const ledger =
              arm === "baseline"
                ? null
                : arm === "global"
                  ? global
                  : arm === "prior"
                    ? treatment
                    : arm === "shuffled"
                      ? shuffled
                      : ungated;
            const cell = arm === "global" ? "all" : instance.family;
            const order = orderBy(ledger, cell);
            await runSpec({
              phase,
              arm,
              instance,
              trialIndex: t,
              skills: POOL_NAMES,
              ...(order ? { order } : {}),
            });
          }
        }
      }
    }
    const rs = [...records.values()].filter((r) => r.phase === phase);
    const learned = [...records.values()].filter((r) => r.phase === learnPhase);
    const of = (arm: string) => rs.filter((r) => r.arm === arm);
    const summaries = [summarizeArm(learned), ...evalArms.map((a) => summarizeArm(of(a)))].filter(
      Boolean,
    ) as ArmSummary[];
    const contrasts: PairedContrast[] = [];
    for (const metric of ["pass", "readCorrect"] as const) {
      for (const arm of evalArms.slice(1)) {
        const c = pairedContrast(of(arm), of("baseline"), metric);
        if (c) {
          contrasts.push(c);
        }
      }
      for (const b of ["global", "shuffled", "ungated"] as const) {
        const c = pairedContrast(of("prior"), of(b), metric);
        if (c) {
          contrasts.push(c);
        }
      }
    }
    report.push(
      "## Arms (frozen evaluation on qualification seeds)",
      "",
      `Learning: ${learned.length} gated-eligible episodes on development seeds ${learnSeeds.join(", ")} (Thompson ordering). Evaluation seeds ${evalSeeds.join(", ")}.`,
      "",
      renderArmTable(summaries),
      "",
      renderContrasts(contrasts),
      "",
      "### Learned ledger (treatment), posterior mean by family cell",
      "",
      "| Cell | Skill | Mean | n |",
      "| --- | --- | ---: | ---: |",
      ...treatment
        .snapshot()
        .filter((s) => s.n > 0)
        .map((s) => `| ${s.cell} | ${s.skill} | ${s.mean.toFixed(3)} | ${s.n} |`),
      "",
      "Reading: `prior minus baseline` is the effect of experience-guided ordering; `prior minus global` is what context cells add over popularity; `prior minus shuffled` is whether the specific associations (not just a changed order) drive it; `prior minus ungated` is what the outcome gate buys over co-occurrence.",
      "",
    );
    Object.assign(summary, {
      learnSeeds,
      evalSeeds,
      summaries,
      contrasts,
      ledger: treatment.snapshot(),
    });
  }

  const spent = spentUsd(records.values());
  report.push(
    `Estimated spend over all phases in this output directory: $${spent.toFixed(2)} (list prices; not an invoice).`,
    "",
  );
  await fs.writeFile(path.join(out, `report-${phase}.md`), report.join("\n"), "utf-8");
  await fs.writeFile(
    path.join(out, `summary-${phase}.json`),
    `${JSON.stringify({ ...summary, spentUsd: spent }, null, 2)}\n`,
    "utf-8",
  );
  process.stdout.write(`${report.join("\n")}\n`);
}

async function confirm(planned: number, existing: Map<string, TrialRecord>): Promise<void> {
  process.stderr.write(
    `planned ${planned} trial(s); ${existing.size} record(s) already on disk; ceiling $${ceilingUsd}; model ${args.model}\n`,
  );
  if (planned > 200 && !args.yes) {
    throw new Error(`${planned} real turns planned (> 200); pass --yes to confirm`);
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
