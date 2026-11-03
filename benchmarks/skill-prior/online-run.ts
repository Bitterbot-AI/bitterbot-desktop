/**
 * Online experience study: can an agent learn which look-alike skill fits a
 * workspace from nothing but accept/reject feedback, and which FORMAT of its
 * own experience lets it learn fastest? (Design: docs/plans PLAN-60.)
 *
 *   node --import tsx benchmarks/skill-prior/online-run.ts --episodes 8 --yes
 *
 * Every `<workspace>:<family>` cell starts cold. Episode e of every cell uses
 * the same development seed, so all arms face the same task stream. After each
 * episode the arm's memory for that cell is updated from the verdict alone:
 *   none             nothing carried forward
 *   lessons          a free-text lesson the same model writes after the verdict
 *   episodes         raw episode list: skill used, answer, verdict
 *   records          per-skill accepted/runs counts (prompt block)
 *   records-index    the same counts as `<evidence>` lines in the skills index
 *   records-lessons  counts plus lessons
 *   bandit           reference: Thompson sampling picks the skill, which is
 *                    forced alone into the index (no model choice)
 * Retrieval is fixed (same cell, all prior episodes); memory goes into the
 * task prompt for every prompt arm, so only the format differs.
 *
 * Primary (pre-registered): records minus lessons on the per-cell mean pass
 * over episodes 1..E-1 (episode 0 is cold for every arm), exact sign test
 * over cells and family-cluster bootstrap. Secondary, Holm: records minus
 * none, lessons minus none, records-lessons minus records, records minus
 * episodes, records-index minus records. Reference: records minus bandit,
 * cumulative regret against the truth-table oracle.
 *
 * Records under <out> (default ~/bitterbot-skill-prior/online), never under
 * ~/.bitterbot. Resumable: traces and lessons are rebuilt from disk.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveApiKeyForProvider } from "../../src/agents/model-auth.js";
import { loadConfig } from "../../src/config/config.js";
import { startEventJournal } from "../../src/infra/event-journal.js";
import { bootstrapMeanCi } from "../../src/memory/skill-evolution/bootstrap-ci.js";
import { exactSignTest } from "../../src/memory/skill-evolution/sign-test.js";
import { clusterBootstrapCi, holm, shuffled } from "./conventions-analysis.js";
import {
  CONVENTION_POOL,
  CONVENTION_POOL_NAMES,
  type ConventionInstance,
  conventionInstance,
  ENVS,
} from "./conventions.js";
import {
  estimateUsd,
  makeExecutor,
  trialKey,
  type TrialRecord,
  type TrialSpec,
} from "./executor.js";
import {
  cellScores,
  creditedSkill,
  cumulativeRegret,
  type EpisodeTrace,
  learningCurve,
  lessonPrompt,
  ONLINE_ARMS,
  type OnlineArm,
  recordsFrom,
  renderMemory,
  thompsonPick,
} from "./online.js";
import { FAMILIES, writePool } from "./pool.js";
import { seedsIn } from "./tasks.js";

const SALT = "conventions-v1";
/** Default families: the eight that passed the latent-convention truth table. */
const DEFAULT_FAMILIES = FAMILIES.filter((f) => f !== "multi-file-rename");

const { values: args } = parseArgs({
  options: {
    episodes: { type: "string", default: "8" },
    model: { type: "string", default: "anthropic/claude-haiku-4-5" },
    out: { type: "string" },
    "truth-from": { type: "string" },
    "ceiling-usd": { type: "string", default: "150" },
    "max-runs": { type: "string" },
    families: { type: "string" },
    envs: { type: "string" },
    arms: { type: "string" },
    "timeout-ms": { type: "string" },
    "keep-trials": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const E = Number(args.episodes);
const families = args.families
  ? (args.families.split(",").map((f) => f.trim()) as (typeof FAMILIES)[number][])
  : [...DEFAULT_FAMILIES];
const envs = args.envs
  ? (args.envs.split(",").map((e) => e.trim()) as (typeof ENVS)[number][])
  : [...ENVS];
const arms = (
  args.arms ? ONLINE_ARMS.filter((a) => args.arms!.split(",").includes(a)) : ONLINE_ARMS
) as readonly OnlineArm[];
const ceilingUsd = Number(args["ceiling-usd"]);
const maxRuns =
  args["max-runs"] !== undefined ? Number(args["max-runs"]) : Number.POSITIVE_INFINITY;
const modelTag = args.model!.replace(/^.*\//, "");
const home = os.homedir();
const out = path.resolve(args.out ?? path.join(home, "bitterbot-skill-prior", "online"));
const truthFrom = path.resolve(
  args["truth-from"] ?? path.join(home, "bitterbot-skill-prior", "conventions"),
);
for (const p of [out, truthFrom]) {
  if (p.startsWith(path.join(home, ".bitterbot"))) {
    throw new Error("--out / --truth-from must not live under ~/.bitterbot");
  }
}
const PHASE = modelTag === "claude-haiku-4-5" ? "ol-main" : `ol-main@${modelTag}`;
const TRAIN_PHASE = modelTag === "claude-haiku-4-5" ? "cv-train" : `cv-train@${modelTag}`;
/** Episode seeds: development split, far from the train (1..) and pilot (5000..) seeds. */
const SEEDS = seedsIn("development", 20_000, E, SALT);

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");
const cellOf = (inst: ConventionInstance) => `${inst.env}:${inst.family}`;
const variantsOf = (inst: ConventionInstance) =>
  [inst.correctSkill, ...inst.decoySkills].toSorted();
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

interface LessonRow {
  key: string;
  lesson: string;
  tokensIn: number;
  tokensOut: number;
}

async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    return (await fs.readFile(file, "utf-8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/** Lesson writer: the same model, one direct call, keys from env or the operator's auth path. */
async function makeLessonWriter(): Promise<
  (prompt: string) => Promise<{ text: string; tokensIn: number; tokensOut: number }>
> {
  const [provider, model] = args.model!.split("/") as [string, string];
  const envKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  let key = envKey?.trim();
  if (!key) {
    const resolved = await resolveApiKeyForProvider({ provider, cfg: loadConfig() });
    key = resolved?.apiKey ?? undefined;
  }
  if (!key) {
    throw new Error(`no API key for ${provider} (lesson writer)`);
  }
  return async (prompt: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (provider === "anthropic") {
          const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: 200,
              messages: [{ role: "user", content: prompt }],
            }),
          });
          if (!res.ok) {
            throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
          }
          const d = (await res.json()) as {
            content?: Array<{ text?: string }>;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          return {
            text: d.content?.map((c) => c.text ?? "").join("") ?? "",
            tokensIn: d.usage?.input_tokens ?? 0,
            tokensOut: d.usage?.output_tokens ?? 0,
          };
        }
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_completion_tokens: 2000,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) {
          throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const d = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        return {
          text: d.choices?.[0]?.message?.content ?? "",
          tokensIn: d.usage?.prompt_tokens ?? 0,
          tokensOut: d.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        if (attempt >= 4) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)));
      }
    }
  };
}

/** Per-cell paired contrast over cell scores: sign test, instance bootstrap, family-cluster bootstrap. */
function cellContrast(a: Map<string, number>, b: Map<string, number>) {
  const deltas: number[] = [];
  const byFam = new Map<string, number[]>();
  for (const [cell, s] of a) {
    const o = b.get(cell);
    if (o === undefined) {
      continue;
    }
    deltas.push(s - o);
    const fam = cell.split(":")[1]!;
    byFam.set(fam, [...(byFam.get(fam) ?? []), s - o]);
  }
  return {
    n: deltas.length,
    sign: exactSignTest(deltas),
    ci: bootstrapMeanCi(deltas),
    cluster: clusterBootstrapCi(byFam),
  };
}

async function main(): Promise<void> {
  await fs.mkdir(out, { recursive: true });
  await writePool(path.join(out, "pool"), CONVENTION_POOL);
  const emptyRoot = path.join(out, "empty");
  await fs.mkdir(emptyRoot, { recursive: true });
  const recordsFile = path.join(out, "records.jsonl");
  const lessonsFile = path.join(out, "lessons.jsonl");
  const journal = startEventJournal({ dbPath: path.join(out, "journal.sqlite") });
  if (!journal) {
    throw new Error("event journal could not start; skill reads would be unobservable");
  }
  const records = new Map((await readJsonl<TrialRecord>(recordsFile)).map((r) => [r.key, r]));
  const lessons = new Map((await readJsonl<LessonRow>(lessonsFile)).map((l) => [l.key, l]));

  // Oracle for regret: right-forced pass per family from this model's truth table.
  const truth = (await readJsonl<TrialRecord>(path.join(truthFrom, "records.jsonl"))).filter(
    (r) =>
      r.phase === TRAIN_PHASE && r.indexOrder.length === 1 && r.indexOrder[0] === r.correctSkill,
  );
  const oracle: Record<string, number> = {};
  for (const f of families) {
    const rs = truth.filter((r) => r.family === f);
    oracle[f] = rs.length ? rs.reduce((s, r) => s + r.pass, 0) / rs.length : 1;
  }

  const protocol = {
    salt: SALT,
    model: args.model,
    families,
    envs,
    seeds: SEEDS,
    arms: ONLINE_ARMS,
    credit: "last variant read",
    lessonWriter: "same model, one call after the verdict, <= 2 sentences",
    memory: "prompt prefix for prompt arms; same cell, all prior episodes",
    primary:
      "records minus lessons, per-cell mean pass over episodes 1..E-1, sign test + family-cluster bootstrap",
    secondary: [
      "records minus none",
      "lessons minus none",
      "records-lessons minus records",
      "records minus episodes",
      "records-index minus records",
    ],
    reference: ["records minus bandit", "cumulative regret vs truth-table oracle"],
  };
  const protoFile = path.join(out, `protocol-${PHASE}.json`);
  const protoHash = hashOf(JSON.stringify(protocol));
  try {
    const prev = JSON.parse(await fs.readFile(protoFile, "utf-8")) as { hash: string };
    if (prev.hash !== protoHash) {
      throw new Error(`protocol changed since the first run (${protoFile}); use a new --out`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    await fs.writeFile(protoFile, JSON.stringify({ hash: protoHash, protocol }, null, 2), "utf-8");
  }

  const execute = makeExecutor({
    cfg: loadConfig(),
    emptyRoot,
    trialsRoot: path.join(out, "trials"),
    modelSpec: args.model!,
    keepTrialDirs: args["keep-trials"],
    timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 120_000,
  });
  const writeLesson = arms.some((a) => a.includes("lessons")) ? await makeLessonWriter() : null;
  const spent = () => {
    let s = 0;
    for (const r of records.values()) {
      s += estimateUsd(r);
    }
    for (const l of lessons.values()) {
      s += estimateUsd({
        tokensIn: l.tokensIn,
        tokensOut: l.tokensOut,
        cacheRead: 0,
        model: args.model!,
      });
    }
    return s;
  };

  const planned = E * envs.length * families.length * arms.length;
  process.stderr.write(
    `planned ${planned} episode run(s); ${records.size} on disk; ceiling $${ceilingUsd}; model ${args.model}\n`,
  );
  if (planned > 200 && !args.yes) {
    throw new Error(`${planned} real turns planned (> 200); pass --yes to confirm`);
  }

  // traces[arm][cell]
  const traces = new Map<string, EpisodeTrace[]>();
  const tk = (arm: string, cell: string) => `${arm}|${cell}`;
  const rows: Array<{
    arm: OnlineArm;
    cell: string;
    family: string;
    episode: number;
    pass: number;
  }> = [];
  let runs = 0;

  for (let e = 0; e < E; e++) {
    for (const env of envs) {
      for (const family of families) {
        const inst = conventionInstance(env, family, SEEDS[e]!);
        const cell = cellOf(inst);
        const variants = variantsOf(inst);
        const order = shuffled(CONVENTION_POOL_NAMES, `${inst.task.id}:0`);
        for (const arm of arms) {
          const hist = traces.get(tk(arm, cell)) ?? [];
          const memory = renderMemory(arm, hist, variants);
          const rec = recordsFrom(hist, variants);
          const forced = arm === "bandit" ? thompsonPick(rec, variants, `${cell}:${e}`) : null;
          const spec: TrialSpec = {
            phase: PHASE,
            arm,
            instance: memory
              ? { ...inst, task: { ...inst.task, prompt: `${memory}${inst.task.prompt}` } }
              : inst,
            trialIndex: 0,
            skills: forced ? [forced] : CONVENTION_POOL_NAMES,
            pool: CONVENTION_POOL,
            correctSkill: inst.correctSkill,
            decoySkills: inst.decoySkills,
            cell,
            order: forced ? undefined : order,
            ...(arm === "records-index" && hist.length ? { evidence: rec } : {}),
          };
          const key = trialKey(spec);
          let r = records.get(key);
          const fresh = !r;
          if (!r) {
            if (runs >= maxRuns) {
              throw new Error(`--max-runs ${maxRuns} reached`);
            }
            if (spent() >= ceilingUsd) {
              throw new Error(`spend ceiling reached: $${spent().toFixed(2)}`);
            }
            r = await execute(spec);
            for (let a = 0; a < 6 && /No available auth profile/.test(r.error ?? ""); a++) {
              process.stderr.write(
                `  auth profile in cooldown; waiting 90 s (attempt ${a + 1}/6)\n`,
              );
              await new Promise((res) => setTimeout(res, 90_000));
              r = await execute(spec);
            }
            records.set(key, r);
            runs++;
            await fs.appendFile(recordsFile, `${JSON.stringify(r)}\n`, "utf-8");
          }
          const trace: EpisodeTrace = {
            episode: e,
            skill: forced ?? creditedSkill(r.read, variants),
            read: r.read.filter((n) => variants.includes(n)),
            final: r.final ?? null,
            accepted: r.pass === 1,
          };
          if (arm === "lessons" || arm === "records-lessons") {
            let l = lessons.get(key);
            if (!l) {
              const w = await writeLesson!(
                lessonPrompt({
                  task: inst.task.prompt,
                  read: trace.read,
                  final: trace.final,
                  accepted: trace.accepted,
                  previous: hist.map((h) => h.lesson ?? "").filter(Boolean),
                }),
              );
              l = {
                key,
                lesson: w.text.trim().slice(0, 400),
                tokensIn: w.tokensIn,
                tokensOut: w.tokensOut,
              };
              lessons.set(key, l);
              await fs.appendFile(lessonsFile, `${JSON.stringify(l)}\n`, "utf-8");
            }
            trace.lesson = l.lesson;
          }
          traces.set(tk(arm, cell), [...hist, trace]);
          rows.push({ arm, cell, family, episode: e, pass: r.pass });
          if (fresh) {
            process.stderr.write(
              `  ${PHASE}/${arm} ${cell} e${e}: pass=${r.pass} read=${trace.read.join("+") || "-"} ${Math.round(r.wallMs / 1000)}s $${spent().toFixed(2)}${r.error ? ` ERROR ${r.error.slice(0, 80)}` : ""}\n`,
            );
          }
        }
      }
    }
  }

  // ── Report ──
  const of = (arm: OnlineArm) => rows.filter((r) => r.arm === arm);
  const curves = new Map(arms.map((a) => [a, learningCurve(of(a))]));
  const scores = new Map(arms.map((a) => [a, cellScores(of(a))]));
  const report: string[] = [
    "# Online experience study",
    "",
    `Generated ${new Date().toISOString()}. Model ${args.model}. ${families.length} families x ${envs.length} workspaces = ${families.length * envs.length} cells, ${E} episodes each, seeds ${SEEDS.join(", ")}. Protocol hash ${protoHash.slice(0, 16)}. Records: ${recordsFile}.`,
    "",
    "## Learning curves (pass by episode)",
    "",
    `| Arm | ${Array.from({ length: E }, (_, e) => `e${e}`).join(" | ")} | Mean e1+ | Regret |`,
    `| --- | ${Array.from({ length: E }, () => "---:").join(" | ")} | ---: | ---: |`,
    ...arms.map((a) => {
      const c = curves.get(a)!;
      const s = [...scores.get(a)!.values()];
      const m = s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0;
      return `| ${a} | ${c.map((p) => pct(p.pass)).join(" | ")} | ${pct(m)} | ${cumulativeRegret(of(a), oracle).toFixed(1)} |`;
    }),
    "",
    `Regret: sum over episodes of (truth-table right-forced pass for the family minus achieved pass); oracle ${families.map((f) => `${f} ${pct(oracle[f]!)}`).join(", ")}.`,
    "",
  ];
  const pairs: Array<[OnlineArm, OnlineArm, "primary" | "secondary" | "reference"]> = [
    ["records", "lessons", "primary"],
    ["records", "none", "secondary"],
    ["lessons", "none", "secondary"],
    ["records-lessons", "records", "secondary"],
    ["records", "episodes", "secondary"],
    ["records-index", "records", "secondary"],
    ["records", "bandit", "reference"],
    ["episodes", "none", "reference"],
  ];
  const results = pairs
    .filter(([a, b]) => arms.includes(a) && arms.includes(b))
    .map(([a, b, kind]) => ({ a, b, kind, c: cellContrast(scores.get(a)!, scores.get(b)!) }));
  const sec = results.filter((r) => r.kind === "secondary");
  const adj = holm(sec.map((r) => r.c.sign.pValue));
  report.push(
    "## Paired by cell (mean pass over episodes 1+)",
    "",
    "| Contrast | Role | Cells | W / L / T | Delta | 95% CI | Family-cluster CI | Sign p | Holm p |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((r) => {
      const h = r.kind === "secondary" ? adj[sec.indexOf(r)]!.toFixed(4) : "";
      const cl = r.c.cluster
        ? `[${(r.c.cluster.lo * 100).toFixed(1)}, ${(r.c.cluster.hi * 100).toFixed(1)}]`
        : "";
      return `| ${r.a} minus ${r.b} | ${r.kind} | ${r.c.n} | ${r.c.sign.wins} / ${r.c.sign.losses} / ${r.c.sign.ties} | ${(r.c.ci.meanDelta * 100).toFixed(1)} pp | [${(r.c.ci.ci95Low * 100).toFixed(1)}, ${(r.c.ci.ci95High * 100).toFixed(1)}] | ${cl} | ${r.c.sign.pValue.toFixed(4)} | ${h} |`;
    }),
    "",
    `Spend in this output directory: $${spent().toFixed(2)} (list prices, agent runs plus lesson calls).`,
    "",
  );
  const tag = PHASE;
  await fs.writeFile(path.join(out, `report-${tag}.md`), report.join("\n"), "utf-8");
  await fs.writeFile(
    path.join(out, `summary-${tag}.json`),
    `${JSON.stringify({ protoHash, oracle, curves: Object.fromEntries(curves), results }, null, 2)}\n`,
    "utf-8",
  );
  process.stdout.write(`${report.join("\n")}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
