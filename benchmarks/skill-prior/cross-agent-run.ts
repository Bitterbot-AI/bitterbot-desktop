import { createHash } from "node:crypto";
import fs from "node:fs/promises";
/**
 * Cross-agent evidence cards: is experience other agents earned worth more to
 * a recipient than the experience it earned itself, at equal per-agent budget?
 * (Design and registration: docs/plans/PLAN-63-CROSS-AGENT-EVIDENCE-CARDS.md;
 * methods: benchmarks/skill-prior/README.md, "Cross-agent evidence cards".)
 *
 *   # free end-to-end dry run with a simulated reader (no model calls)
 *   node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase all --simulate
 *
 *   # the study
 *   node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase experience --yes
 *   node --import tsx benchmarks/skill-prior/cross-agent-run.ts --phase eval --yes
 *
 * Phases:
 *   experience  One recipient (r0) and N donors (d1..dN) each work `--budget`
 *               episodes in every `<workspace>:<family>` cell on their own
 *               development seeds. An agent sees only its own earlier outcomes
 *               in the cell, as `<evidence>` lines on the skills index, and
 *               gets accept/reject after each episode. Each donor then signs
 *               its records into a card bundle under <out>/bundles.
 *   eval        The recipient verifies and imports the bundles, then faces
 *               held-out instances (the `final` seed split) under twelve arms
 *               that differ only in the `<evidence>` lines (see XA_ARMS).
 *               The protocol is hashed before the first run. Primary: peer
 *               minus own on pass, per cell. Then a fixed-sequence family
 *               (GATE); everything after the first failure is exploratory.
 *   all         experience, then eval.
 *
 * Records go to <out>/records.jsonl (resumable by key); trial dirs, journal,
 * keys and bundles live under <out> (default ~/bitterbot-skill-prior/cross-agent),
 * never under ~/.bitterbot.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { keyPairFromPrivateKeyPem } from "../../src/commerce/envelope.js";
import { loadConfig } from "../../src/config/config.js";
import { startEventJournal } from "../../src/infra/event-journal.js";
import { type ArmSummary, readCorrect, renderArmTable, summarizeArm } from "./analysis.js";
import { shuffled } from "./conventions-analysis.js";
import {
  CONVENTION_POOL,
  CONVENTION_POOL_NAMES,
  type ConventionInstance,
  conventionInstance,
  conventionOf,
  ENVS,
} from "./conventions.js";
import {
  type ArmInputs,
  bundleDigest,
  type CardBundle,
  cardLines,
  type CardView,
  cellContrast,
  type CellRecords,
  type EvalRow,
  exportCardBundle,
  flips,
  GATE,
  generateKeyPair,
  importCardBundle,
  type KeyPair,
  SIGN_ALPHA,
  originOf,
  type Records,
  referencePick,
  renderContrastRows,
  renderGate,
  runGate,
  viewFor,
  XA_ARMS,
  type XaArm,
} from "./cross-agent.js";
import {
  estimateUsd,
  makeExecutor,
  trialKey,
  type TrialRecord,
  type TrialSpec,
} from "./executor.js";
import { creditedSkill, type EpisodeTrace, recordsFrom } from "./online.js";
import { FAMILIES, writePool } from "./pool.js";
import { mulberry32, seedsIn } from "./tasks.js";

const SALT = "cross-agent-v1";

const { values: args } = parseArgs({
  options: {
    phase: { type: "string" },
    donors: { type: "string", default: "3" },
    budget: { type: "string", default: "2" },
    "eval-seeds": { type: "string", default: "2" },
    model: { type: "string", default: "anthropic/claude-haiku-4-5" },
    "donor-model": { type: "string" },
    out: { type: "string" },
    "ceiling-usd": { type: "string", default: "50" },
    "max-runs": { type: "string" },
    families: { type: "string" },
    envs: { type: "string" },
    arms: { type: "string" },
    "timeout-ms": { type: "string" },
    "keep-trials": { type: "boolean", default: false },
    simulate: { type: "boolean", default: false },
    "sim-follow": { type: "string", default: "0.9" },
    yes: { type: "boolean", default: false },
  },
});

const phase = args.phase;
if (phase !== "experience" && phase !== "eval" && phase !== "all") {
  throw new Error("--phase must be experience | eval | all");
}
const SIM = args.simulate;
const families = args.families
  ? (args.families.split(",").map((f) => f.trim()) as (typeof FAMILIES)[number][])
  : [...FAMILIES];
const envs = args.envs
  ? (args.envs.split(",").map((e) => e.trim()) as (typeof ENVS)[number][])
  : [...ENVS];
const N_DONORS = Number(args.donors);
const BUDGET = Number(args.budget);
const EVAL_SEEDS = Number(args["eval-seeds"]);
if (!(N_DONORS >= 1) || !(BUDGET >= 1) || !(EVAL_SEEDS >= 1)) {
  throw new Error("--donors, --budget and --eval-seeds must be at least 1");
}
const HALF = Math.floor(BUDGET / 2);
const recipientModel = SIM ? "sim/reference-reader" : args.model!;
const donorModel = SIM ? "sim/reference-reader" : (args["donor-model"] ?? args.model!);
const ceilingUsd = Number(args["ceiling-usd"]);
const maxRuns = args["max-runs"] ? Number(args["max-runs"]) : Number.POSITIVE_INFINITY;
const out = path.resolve(
  args.out ??
    path.join(os.homedir(), "bitterbot-skill-prior", SIM ? "cross-agent-sim" : "cross-agent"),
);
if (out.startsWith(path.join(os.homedir(), ".bitterbot"))) {
  throw new Error("--out must not live under ~/.bitterbot");
}

const AGENTS = ["r0", ...Array.from({ length: N_DONORS }, (_, i) => `d${i + 1}`)];
const DONORS = AGENTS.slice(1);
const modelOf = (agent: string) => (agent === "r0" ? recipientModel : donorModel);
const EXP_PHASE = SIM ? "xa-sim-exp" : "xa-exp";
const EVAL_PHASE = SIM ? "xa-sim-eval" : "xa-eval";

const hashOf = (body: string) => createHash("sha256").update(body).digest("hex");
const SKILL_HASHES: Record<string, string> = Object.fromEntries(
  CONVENTION_POOL.map((s) => [s.name, hashOf(s.body)]),
);
const cellOf = (inst: ConventionInstance) => `${inst.env}:${inst.family}`;
const variantsOf = (inst: ConventionInstance) =>
  [inst.correctSkill, ...inst.decoySkills].toSorted();
const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`;

/** Development seeds for one agent's episodes: disjoint blocks, far from earlier studies. */
const expSeeds = (agentIndex: number) =>
  seedsIn("development", 40_000 + 1000 * agentIndex, BUDGET, SALT);
const evalSeeds = seedsIn("final", 60_000, EVAL_SEEDS, SALT);

type Execute = (spec: TrialSpec, model: string, view: CardView) => Promise<TrialRecord>;

/**
 * Dry-run reader: follows the card as the reference reader would with
 * probability `--sim-follow`, otherwise opens a variant at random; the right
 * variant passes 95% of the time and a wrong one never. Seeded by trial key.
 */
function makeSimExecutor(follow: number): Execute {
  return async (spec, model, view) => {
    const inst = spec.instance as ConventionInstance;
    const variants = variantsOf(inst);
    const key = trialKey(spec);
    const rng = mulberry32(createHash("sha256").update(`sim:${key}`).digest().readUInt32BE(0));
    const probs = referencePick(view, variants);
    let pick = variants[Math.floor(rng() * variants.length)]!;
    if (rng() < follow) {
      let u = rng();
      for (const v of variants) {
        u -= probs[v]!;
        if (u <= 0) {
          pick = v;
          break;
        }
      }
    }
    const pass = pick === inst.correctSkill && rng() < 0.95 ? 1 : 0;
    return {
      key,
      phase: spec.phase,
      arm: spec.arm,
      taskId: inst.task.id,
      family: inst.family,
      seed: inst.seed,
      trialIndex: spec.trialIndex,
      indexOrder: [...(spec.order ?? spec.skills)],
      pass,
      read: [pick],
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      wallMs: 0,
      model,
      error: null,
      runId: `sim-${hashOf(key).slice(0, 12)}`,
      correctSkill: inst.correctSkill,
      decoySkills: [...inst.decoySkills],
      cell: spec.cell,
      final: null,
    };
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

async function loadOrCreateKey(file: string): Promise<KeyPair> {
  try {
    return keyPairFromPrivateKeyPem(await fs.readFile(file, "utf-8"));
  } catch {
    const key = generateKeyPair();
    await fs.writeFile(file, key.privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return key;
  }
}

/** One agent's episode traces per cell, rebuilt from its experience records. */
function tracesOf(
  records: ReadonlyMap<string, TrialRecord>,
  agent: string,
): Map<string, EpisodeTrace[]> {
  const seeds = expSeeds(AGENTS.indexOf(agent));
  const m = new Map<string, EpisodeTrace[]>();
  for (const r of records.values()) {
    if (r.phase !== EXP_PHASE || r.arm !== agent || !r.cell) {
      continue;
    }
    const episode = seeds.indexOf(r.seed);
    if (episode < 0) {
      continue;
    }
    const variants = [r.correctSkill!, ...(r.decoySkills ?? [])];
    m.set(r.cell, [
      ...(m.get(r.cell) ?? []),
      {
        episode,
        // An errored run earns no record: nothing was verified.
        skill: r.error === null ? creditedSkill(r.read, variants) : null,
        read: r.read,
        final: r.final ?? null,
        accepted: r.pass === 1,
      },
    ]);
  }
  for (const list of m.values()) {
    list.sort((a, b) => a.episode - b.episode);
  }
  return m;
}

const ALL_VARIANTS = (family: string) => ["a", "b", "c", "d"].map((v) => `xp-${family}-${v}`);
const familyOfCell = (cell: string) => cell.slice(cell.indexOf(":") + 1);

function recordsOf(traces: Map<string, EpisodeTrace[]>, upTo = BUDGET): CellRecords {
  const cells: CellRecords = {};
  for (const [cell, list] of traces) {
    cells[cell] = recordsFrom(
      list.filter((t) => t.episode < upTo),
      ALL_VARIANTS(familyOfCell(cell)),
    );
  }
  return cells;
}

async function main(): Promise<void> {
  await fs.mkdir(path.join(out, "bundles"), { recursive: true });
  await fs.mkdir(path.join(out, "agents"), { recursive: true });
  const recordsFile = path.join(out, "records.jsonl");
  const records = await loadRecords(recordsFile);
  let execute: Execute;
  if (SIM) {
    execute = makeSimExecutor(Number(args["sim-follow"]));
  } else {
    await writePool(path.join(out, "pool"), CONVENTION_POOL);
    const emptyRoot = path.join(out, "empty");
    await fs.mkdir(emptyRoot, { recursive: true });
    if (!startEventJournal({ dbPath: path.join(out, "journal.sqlite") })) {
      throw new Error("event journal could not start; skill reads would be unobservable");
    }
    const cfg = loadConfig();
    const real = new Map<string, ReturnType<typeof makeExecutor>>();
    execute = async (spec, model) => {
      let ex = real.get(model);
      if (!ex) {
        ex = makeExecutor({
          cfg,
          emptyRoot,
          trialsRoot: path.join(out, "trials"),
          modelSpec: model,
          keepTrialDirs: args["keep-trials"],
          timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 120_000,
        });
        real.set(model, ex);
      }
      return ex(spec);
    };
  }
  const spent = () => {
    let s = 0;
    for (const r of records.values()) {
      s += estimateUsd(r);
    }
    return s;
  };
  let runsThisSession = 0;
  const runSpec = async (spec: TrialSpec, model: string, view: CardView): Promise<TrialRecord> => {
    const key = trialKey(spec);
    const hit = records.get(key);
    if (hit) {
      return hit;
    }
    if (runsThisSession >= maxRuns) {
      throw new Error(`--max-runs ${maxRuns} reached`);
    }
    if (spent() >= ceilingUsd) {
      throw new Error(`spend ceiling reached: $${spent().toFixed(2)} >= $${ceilingUsd}`);
    }
    let r = await execute(spec, model, view);
    for (let a = 0; a < 6 && /No available auth profile/.test(r.error ?? ""); a++) {
      process.stderr.write(`  auth profile in cooldown; waiting 90 s (attempt ${a + 1}/6)\n`);
      await new Promise((resolve) => setTimeout(resolve, 90_000));
      r = await execute(spec, model, view);
    }
    records.set(key, r);
    runsThisSession += 1;
    await fs.appendFile(recordsFile, `${JSON.stringify(r)}\n`, "utf-8");
    if (!SIM) {
      process.stderr.write(
        `  ${spec.phase}/${spec.arm} ${spec.cell} s${spec.instance.seed}: pass=${r.pass} read=${r.read.join("+") || "-"} ${Math.round(r.wallMs / 1000)}s $${spent().toFixed(2)}${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ""}\n`,
      );
    }
    return r;
  };
  const confirm = (planned: number, what: string) => {
    process.stderr.write(
      `${what}: ${planned} trial(s) planned; ${records.size} record(s) on disk; ceiling $${ceilingUsd}; recipient ${recipientModel}; donors ${donorModel}\n`,
    );
    if (!SIM && planned > 200 && !args.yes) {
      throw new Error(`${planned} real turns planned (> 200); pass --yes to confirm`);
    }
  };

  const report: string[] = [
    `# Cross-agent evidence cards: phase ${phase}${SIM ? " (SIMULATED reader, no model calls)" : ""}`,
    "",
    `Generated ${new Date().toISOString()}. Recipient ${recipientModel}; ${N_DONORS} donor(s) on ${donorModel}; budget ${BUDGET} episode(s) per agent per cell; ${families.length} families x ${envs.length} workspaces = ${families.length * envs.length} cells. Records: ${recordsFile}.`,
    "",
  ];
  const summary: Record<string, unknown> = {
    phase,
    simulated: SIM,
    recipientModel,
    donorModel,
    donors: N_DONORS,
    budget: BUDGET,
    out,
  };

  // ------------------------------------------------------------ experience
  if (phase === "experience" || phase === "all") {
    confirm(AGENTS.length * BUDGET * envs.length * families.length, "experience");
    for (let e = 0; e < BUDGET; e++) {
      for (const env of envs) {
        for (const family of families) {
          for (const agent of AGENTS) {
            const seed = expSeeds(AGENTS.indexOf(agent))[e]!;
            const inst = conventionInstance(env, family, seed);
            const cell = cellOf(inst);
            const variants = variantsOf(inst);
            const hist = (tracesOf(records, agent).get(cell) ?? []).filter((t) => t.episode < e);
            const view: CardView = { own: recordsFrom(hist, variants) };
            await runSpec(
              {
                phase: EXP_PHASE,
                arm: agent,
                instance: inst,
                trialIndex: 0,
                skills: CONVENTION_POOL_NAMES,
                pool: CONVENTION_POOL,
                correctSkill: inst.correctSkill,
                decoySkills: inst.decoySkills,
                cell,
                order: shuffled(CONVENTION_POOL_NAMES, `${inst.task.id}:${agent}`),
                evidenceLines: cardLines(view, variants),
              },
              modelOf(agent),
              view,
            );
          }
        }
      }
    }
    // Each donor signs what it learned. The recipient exports nothing.
    for (const agent of DONORS) {
      const key = await loadOrCreateKey(path.join(out, "agents", `${agent}.key.pem`));
      const bundle = exportCardBundle({
        key,
        model: donorModel,
        budget: BUDGET,
        skills: SKILL_HASHES,
        cells: recordsOf(tracesOf(records, agent)),
      });
      await fs.writeFile(
        path.join(out, "bundles", `${agent}.json`),
        `${JSON.stringify(bundle, null, 2)}\n`,
        "utf-8",
      );
    }
    const rows = AGENTS.map((agent) => {
      const rs = [...records.values()].filter((r) => r.phase === EXP_PHASE && r.arm === agent);
      const seeds = expSeeds(AGENTS.indexOf(agent));
      const byEp = seeds.map((s) => {
        const xs = rs.filter((r) => r.seed === s);
        return xs.length ? pct(xs.reduce((a, r) => a + r.pass, 0) / xs.length) : "n/a";
      });
      const cells = recordsOf(tracesOf(records, agent));
      const found = Object.values(cells).filter((c) =>
        Object.values(c).some((x) => x.passed > 0),
      ).length;
      return `| ${agent} | ${modelOf(agent)} | ${rs.length} | ${byEp.join(" / ")} | ${found} of ${Object.keys(cells).length} | ${rs.filter((r) => r.error !== null).length} |`;
    });
    report.push(
      "## Experience (accept/reject feedback only, own records shown)",
      "",
      "| Agent | Model | Episodes | Pass by episode | Cells with an accepted variant | Errors |",
      "| --- | --- | ---: | --- | ---: | ---: |",
      ...rows,
      "",
    );
  }

  // ------------------------------------------------------------------ eval
  if (phase === "eval" || phase === "all") {
    const own = tracesOf(records, "r0");
    if (own.size === 0) {
      throw new Error("no experience records: run --phase experience first");
    }
    // The recipient trusts exactly the donor keys of this study, and verifies every bundle.
    const bundles: CardBundle[] = [];
    const trusted = new Set<string>();
    for (const agent of DONORS) {
      const key = await loadOrCreateKey(path.join(out, "agents", `${agent}.key.pem`));
      trusted.add(originOf(key));
      bundles.push(
        JSON.parse(
          await fs.readFile(path.join(out, "bundles", `${agent}.json`), "utf-8"),
        ) as CardBundle,
      );
    }
    const imported: CellRecords[] = [];
    const importRows: string[] = [];
    bundles.forEach((b, i) => {
      const res = importCardBundle(b, {
        localSkills: SKILL_HASHES,
        trustedOrigins: trusted,
        maxBudget: BUDGET,
      });
      if (!res.ok) {
        throw new Error(`bundle from ${DONORS[i]} refused: ${res.reason}`);
      }
      imported.push(res.cells);
      importRows.push(
        `| ${DONORS[i]} | ${res.origin.slice(0, 24)}... | ${Object.keys(res.cells).length} | ${res.dropped.length} |`,
      );
    });
    const ownFull = recordsOf(own);
    const ownHalf = recordsOf(own, HALF);

    const arms = (
      args.arms ? XA_ARMS.filter((a) => args.arms!.split(",").includes(a)) : XA_ARMS
    ) as readonly XaArm[];
    const protocol = {
      salt: SALT,
      simulated: SIM,
      recipientModel,
      donorModel,
      donors: N_DONORS,
      budget: BUDGET,
      families,
      envs,
      evalSeeds,
      arms: XA_ARMS,
      unit: "cell (<workspace>:<family>), mean pass over its evaluation instances",
      interval: "two-stage bootstrap: families, then cells within family",
      gate: GATE,
      signAlphaOneSided: SIGN_ALPHA,
      errors: "an errored run counts as a failure in every arm",
      bundles: bundleDigest(bundles),
      ownRecords: hashOf(JSON.stringify(ownFull)),
    };
    const protoFile = path.join(out, `protocol-${EVAL_PHASE}.json`);
    const protoHash = hashOf(JSON.stringify(protocol));
    try {
      const prev = JSON.parse(await fs.readFile(protoFile, "utf-8")) as { hash: string };
      if (prev.hash !== protoHash) {
        throw new Error(
          `protocol changed since the first eval run (${protoFile}); use a new --out`,
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

    /** A workspace in use whose convention for this family differs (next in order). */
    const staleEnvFor = (inst: ConventionInstance) => {
      const i = envs.indexOf(inst.env);
      for (let k = 1; k < envs.length; k++) {
        const e = envs[(i + k) % envs.length]!;
        if (conventionOf(e, inst.family) !== inst.variant) {
          return e;
        }
      }
      return null;
    };
    const inputsFor = (inst: ConventionInstance): ArmInputs => {
      const cell = cellOf(inst);
      const staleEnv = staleEnvFor(inst);
      const staleCell = staleEnv ? `${staleEnv}:${inst.family}` : null;
      return {
        ownHalf: ownHalf[cell] ?? {},
        own: ownFull[cell] ?? {},
        donors: imported.map((cells) => cells[cell] ?? {}),
        staleDonors: staleCell ? imported.map((cells) => cells[staleCell] ?? {}) : [],
        correct: inst.correctSkill,
        decoys: inst.decoySkills,
        budget: BUDGET,
        seed: cell,
      };
    };

    const insts: ConventionInstance[] = [];
    for (const seed of evalSeeds) {
      for (const env of envs) {
        for (const family of families) {
          insts.push(conventionInstance(env, family, seed));
        }
      }
    }
    confirm(insts.length * arms.length, "eval");
    const ceiling = new Map<string, number[]>();
    for (const inst of insts) {
      const variants = variantsOf(inst);
      const order = shuffled(CONVENTION_POOL_NAMES, `${inst.task.id}:0`);
      const inputs = inputsFor(inst);
      for (const arm of arms) {
        const view = viewFor(arm, inputs);
        ceiling.set(arm, [
          ...(ceiling.get(arm) ?? []),
          referencePick(view, variants)[inst.correctSkill]!,
        ]);
        await runSpec(
          {
            phase: EVAL_PHASE,
            arm,
            instance: inst,
            trialIndex: 0,
            skills: CONVENTION_POOL_NAMES,
            pool: CONVENTION_POOL,
            correctSkill: inst.correctSkill,
            decoySkills: inst.decoySkills,
            cell: cellOf(inst),
            order,
            evidenceLines: cardLines(view, variants),
          },
          recipientModel,
          view,
        );
      }
    }

    const rs = [...records.values()].filter((r) => r.phase === EVAL_PHASE);
    const of = (arm: string) => rs.filter((r) => r.arm === arm);
    const rows: EvalRow[] = rs.map((r) => ({
      arm: r.arm,
      cell: r.cell!,
      family: r.family,
      taskId: r.taskId,
      pass: r.error === null ? r.pass : 0,
    }));
    const summaries = arms.map((a) => summarizeArm(of(a))).filter(Boolean) as ArmSummary[];
    const mean = (xs: readonly number[]) =>
      xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    const gate = runGate(rows);

    // Coverage: what the pool adds at 0, about half and full local experience.
    const coverage = [
      cellContrast(rows, "pool added to no own experience (peer minus none)", [
        ["peer", 1],
        ["none", -1],
      ]),
      cellContrast(rows, "pool added to half the own budget (own-half+peer minus own-half)", [
        ["own-half+peer", 1],
        ["own-half", -1],
      ]),
      cellContrast(rows, "pool added to the full own budget (own+peer minus own)", [
        ["own+peer", 1],
        ["own", -1],
      ]),
    ];
    // Split by a fact fixed before evaluation: had the recipient already found an accepted variant?
    const solved = new Set(
      Object.entries(ownFull)
        .filter(([, c]) => Object.values(c).some((x) => x.passed > 0))
        .map(([cell]) => cell),
    );
    const allCells = new Set(rows.map((r) => r.cell));
    const unsolved = new Set([...allCells].filter((c) => !solved.has(c)));
    const byState = [
      cellContrast(
        rows,
        "own+peer minus own, cells where the recipient had NOT found an accepted variant",
        [
          ["own+peer", 1],
          ["own", -1],
        ],
        unsolved,
      ),
      cellContrast(
        rows,
        "own+peer minus own, cells where it HAD found one",
        [
          ["own+peer", 1],
          ["own", -1],
        ],
        solved,
      ),
    ];
    const exploratory = [
      cellContrast(rows, "peer minus none", [
        ["peer", 1],
        ["none", -1],
      ]),
      cellContrast(rows, "own minus none", [
        ["own", 1],
        ["none", -1],
      ]),
      cellContrast(rows, "own+peer minus peer", [
        ["own+peer", 1],
        ["peer", -1],
      ]),
      cellContrast(
        rows,
        "peer1 minus own (one peer's experience against the same amount of one's own)",
        [
          ["peer1", 1],
          ["own", -1],
        ],
      ),
      cellContrast(rows, "peer minus peer1 (more donors, same per-agent budget)", [
        ["peer", 1],
        ["peer1", -1],
      ]),
      cellContrast(rows, "peer-liar minus peer (cost of one lying donor)", [
        ["peer-liar", 1],
        ["peer", -1],
      ]),
      cellContrast(rows, "stale minus none (harm of a misapplied pool)", [
        ["stale", 1],
        ["none", -1],
      ]),
      cellContrast(rows, "own+stale minus own (does own experience protect?)", [
        ["own+stale", 1],
        ["own", -1],
      ]),
      cellContrast(rows, "oracle minus peer (room left above the pool)", [
        ["oracle", 1],
        ["peer", -1],
      ]),
    ];
    const flipRows = (
      [
        ["peer", "own"],
        ["peer", "none"],
        ["peer-liar", "peer"],
        ["stale", "none"],
        ["own+stale", "own"],
        ["own+peer", "own"],
      ] as const
    ).map(([a, b]) => {
      const f = flips(rows, a, b);
      return `| ${a} against ${b} | ${f.up} | ${f.down} | ${f.same} |`;
    });

    report.push(
      `Protocol hash ${protoHash.slice(0, 16)} (${protoFile}), written before the first evaluation run. Evaluation seeds ${evalSeeds.join(", ")} (\`final\` split, never used for experience): ${insts.length} instances in ${allCells.size} cells. An errored run counts as a failure.`,
      "",
      "## Bundles the recipient imported",
      "",
      "| Donor | Origin | Cells with records | Records dropped (skill content mismatch) |",
      "| --- | --- | ---: | ---: |",
      ...importRows,
      "",
      "## Arms",
      "",
      renderArmTable(summaries),
      "",
      "| Arm | Reference reader opens the right variant | Model opens it first | Model pass |",
      "| --- | ---: | ---: | ---: |",
      ...arms.map(
        (a) =>
          `| ${a} | ${pct(mean(ceiling.get(a) ?? []))} | ${pct(mean(of(a).map(readCorrect)))} | ${pct(mean(of(a).map((r) => r.pass)))} |`,
      ),
      "",
      "The reference reader uses the card perfectly (best accepted rate, else an untried variant, ties split), so its column is what the shown records can support and the gap to the model is what the model loses.",
      "",
      "## Confirmatory family (fixed order; the first failure makes the rest exploratory)",
      "",
      renderGate(gate),
      "",
      `Unit: the cell. Interval: families resampled, then cells within family. A step is met when the interval lies above zero and, where a sign test applies, its one-sided exact p is below ${SIGN_ALPHA}. The coverage step is a difference in differences and uses the interval alone.`,
      "",
      "## Coverage: what the pool adds as the recipient's own experience grows",
      "",
      renderContrastRows(coverage),
      "",
      renderContrastRows(byState),
      "",
      `The recipient had found an accepted variant in ${solved.size} of ${allCells.size} cells before evaluation.`,
      "",
      "## Exploratory contrasts",
      "",
      renderContrastRows(exploratory),
      "",
      "## Flips per task (negative transfer is the `down` column)",
      "",
      "| Comparison | Fail to pass | Pass to fail | Unchanged |",
      "| --- | ---: | ---: | ---: |",
      ...flipRows,
      "",
    );
    Object.assign(summary, {
      evalSeeds,
      protoHash,
      summaries,
      gate,
      coverage,
      byState,
      exploratory,
      solvedCells: solved.size,
    });
  }

  const usd = spent();
  report.push(`Estimated spend in this output directory: $${usd.toFixed(2)} (list prices).`, "");
  const tag = SIM ? `sim-${phase}` : phase;
  await fs.writeFile(path.join(out, `report-xa-${tag}.md`), report.join("\n"), "utf-8");
  await fs.writeFile(
    path.join(out, `summary-xa-${tag}.json`),
    `${JSON.stringify({ ...summary, spentUsd: usd }, null, 2)}\n`,
    "utf-8",
  );
  process.stdout.write(`${report.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
