import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
/** Operator-only, single-arm baseline difficulty calibration; no skill adoption or efficacy claim. */
import JSON5 from "json5";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefExecution } from "../../src/agents/skills/collective/research-brief.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import {
  BirdFixtureSchema,
  birdProtocol,
  checkBirdSql,
  type BirdGrade,
} from "./bird-calibration.js";
import { StudyLedger } from "./study-ledger.js";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [operation, destination] = process.argv.slice(2);
if (
  !["prepare", "run", "report"].includes(operation) ||
  !destination ||
  !path.isAbsolute(destination) ||
  process.platform !== "linux"
)
  throw new Error(
    "Usage: bird-calibration-run.ts prepare|run|report /absolute/study-directory (Linux)",
  );
const root = path.resolve(destination);
if (!root.startsWith("/home/vicmg/.local/share/bitterbot-studies/bird-calibration-"))
  throw new Error("Requires an isolated BIRD study directory");
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const { createResearchBriefHost } =
  await import("../../src/agents/skills/collective/research-brief.js");
const { executionSources } = await import("./deployment-driver.js");
const { probeStudyImage } = await import("./runtime-preflight.js");
const read = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8"));
const writeNew = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const sourceRoot = "/home/vicmg/.local/share/bitterbot-studies/bird-source-20261112-v1";
const fixtureRoot = "/home/vicmg/.local/share/bitterbot-studies/bird-fixture-20261112-v3";
const model = "anthropic/claude-opus-4-8";
const image = {
  id: "sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535",
  architecture: "amd64",
};
const ceiling = { providerUsd: 30, toolCalls: 22 * 20, wallMs: 22 * 240000 };
const inherited = { authorizationUsd: 250, knownUsd: 35.7496115, unresolvedUsd: 14.4 };
const auditFiles = [
  "bird_sql.py",
  "bird_prepare.py",
  "bird_source.py",
  "test_bird_sql.py",
  "bird_reference_audit.py",
  "bird-upstream-manifest.json",
];
const sources = async () => {
  const hashes = await executionSources();
  for (const name of auditFiles) {
    const relative = `benchmarks/collective-learning/benchmark-audit/${name}`;
    hashes[relative] = sha256(await fs.readFile(path.join(repository, relative)));
  }
  return hashes;
};
type Frozen = {
  schemaVersion: 1;
  purpose: string;
  createdAt: string;
  model: string;
  fixtureHash: string;
  configHash: string;
  checkerHash: string;
  environmentHash: string;
  sourceHashes: Record<string, string>;
  archiveHash: string;
  ceiling: typeof ceiling;
  inherited: typeof inherited;
  schedule: Array<{ id: string; task: string; family: string }>;
  hash: string;
};

if (operation === "prepare") {
  const sourceHashes = await sources();
  const fixture = BirdFixtureSchema.parse(await read(path.join(fixtureRoot, "fixture.json")));
  const protocol = await birdProtocol(fixture, sourceRoot, image.id);
  const probe = await probeStudyImage(image.id);
  const checkerFile = path.join(
    repository,
    "benchmarks/collective-learning/benchmark-audit/bird_sql.py",
  );
  const checks = [];
  for (const item of fixture.cases) {
    if (
      sha256(await fs.readFile(path.join(sourceRoot, `${item.family}.sqlite`))) !==
      item.databaseSha256
    )
      throw new Error("Database drift");
    const result = await checkBirdSql(item, item.referenceSql, sourceRoot, image.id, checkerFile);
    if (result.status !== "pass")
      throw new Error(`Container oracle failed: ${item.id}: ${JSON.stringify(result)}`);
    checks.push({ id: item.id, result });
    console.log(JSON.stringify({ checkerQualified: item.id }));
  }
  const base = JSON5.parse(
    await fs.readFile("/home/vicmg/.bitterbot/bitterbot.json", "utf8"),
  ) as BitterbotConfig;
  await fs.mkdir(root, { mode: 0o700 });
  const agentDir = path.join(root, "state/agents/main/agent");
  const workspace = path.join(root, "state/workspace");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  for (const name of ["auth-profiles.json", "auth.json", "models.json"]) {
    const source = path.join("/home/vicmg/.bitterbot/agents/main/agent", name);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
      throw new Error("Unsafe credential file");
    await fs.writeFile(path.join(agentDir, name), await fs.readFile(source), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const config: BitterbotConfig = {
    models: base.models,
    auth: base.auth,
    tools: base.tools,
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: { primary: model, fallbacks: [] },
        memorySearch: { enabled: false },
        sandbox: {
          ...base.agents?.defaults?.sandbox,
          mode: "all",
          docker: { ...base.agents?.defaults?.sandbox?.docker, image: image.id },
        },
      },
      list: [
        {
          id: "main",
          agentDir,
          workspace,
          tools: base.agents?.list?.find((a) => a.id === "main")?.tools,
        },
      ],
    },
    skills: {
      collective: {
        enabled: true,
        publicMesh: false,
        synthesis: "off",
        validationModel: model,
        budget: ceiling,
      },
    },
  };
  await writeNew(path.join(root, "state/bitterbot.json"), config);
  await writeNew(path.join(root, "fixture.json"), fixture);
  for (const name of ["selection.json", "qualification.json"])
    await fs.copyFile(
      path.join(fixtureRoot, name),
      path.join(root, name),
      fs.constants.COPYFILE_EXCL,
    );
  await writeNew(path.join(root, "container-qualification.json"), {
    checks,
    probe,
    paidModelCalls: 0,
  });
  const host = await createResearchBriefHost(
    config,
    "main",
    "bird-calibration",
    "development",
    image,
    { protocol },
  );
  const schedule = fixture.cases
    .toSorted((a, b) =>
      learningHash(`bird-schedule-v1:${a.id}`).localeCompare(
        learningHash(`bird-schedule-v1:${b.id}`),
      ),
    )
    .map((c) => ({ id: `${c.id}:baseline-0`, task: c.id, family: c.family }));
  await fs.writeFile(
    path.join(root, "source-files.txt"),
    Object.keys(sourceHashes).join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await promisify(execFile)(
    "tar",
    [
      "-czf",
      path.join(root, "execution-source.tar.gz"),
      "-C",
      repository,
      "-T",
      path.join(root, "source-files.txt"),
    ],
    { timeout: 120000 },
  );
  if (learningHash(sourceHashes) !== learningHash(await sources()))
    throw new Error("Source changed during freeze");
  const body = {
    schemaVersion: 1 as const,
    purpose:
      "Development baseline difficulty calibration across 11 database domains; no learning or efficacy comparison",
    createdAt: new Date().toISOString(),
    model,
    fixtureHash: learningHash(fixture),
    configHash: sha256(await fs.readFile(path.join(root, "state/bitterbot.json"))),
    checkerHash: protocol.checkerHash,
    environmentHash: learningHash(host.environment),
    sourceHashes,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    ceiling,
    inherited,
    schedule,
  };
  const frozen: Frozen = { ...body, hash: learningHash(body) };
  await writeNew(path.join(root, "frozen.json"), frozen);
  await writeNew(path.join(root, "payload-review.json"), {
    frozenHash: frozen.hash,
    purpose: body.purpose,
    model,
    prompt: protocol.prompt,
    image,
    ceiling,
    inputs:
      "Only each fixture case.input and its public database bytes; no reference SQL or checker in solver",
    disclosure:
      "Public BIRD questions, schema documentation and queried database rows may be sent to the configured Anthropic model",
    maximumTaskExecutions: 22,
    primaryMetric: "Exact result-bag agreement on a fixed SQLite snapshot",
    secondaryMetrics: [
      "BIRD set execution agreement",
      "unscored row-order agreement",
      "cost",
      "tokens",
      "latency",
    ],
    domains: 11,
    repetitionsPerTask: 1,
    learnedPackages: 0,
    finalEvaluation: false,
    retention: false,
    exclusions: [
      "production memory",
      "private conversations",
      "credentials in prompts",
      "network tools",
      "public publishing",
      "hidden reference SQL",
    ],
    authorization: {
      ...inherited,
      allocatedHereUsd: ceiling.providerUsd,
      remainingUnallocatedUsd: 169.8503885,
      source:
        "User approved $250 total pilot and subsequently requested stronger benchmarks and continuation",
    },
    stopRules: [
      "All 22 scheduled calls complete",
      "Unknown costs or unresolved command",
      "Budget exhausted",
      "Infrastructure or checker failure",
      "Frozen input, source or environment drift",
    ],
    automaticRetries: false,
    outcomeDrivenStopping: false,
    limitations: [
      "No cross-condition inference",
      "Public benchmark contamination possible",
      "One snapshot does not prove semantic SQL correctness",
      "Reference annotations require adjudication",
      "One run per task does not measure sampling stability",
    ],
  });
  console.log(
    JSON.stringify({
      prepared: root,
      frozenHash: frozen.hash,
      tasks: 22,
      quote: host.quote(host.tasks[0]),
      paidModelCalls: 0,
    }),
  );
} else {
  const frozen = (await read(path.join(root, "frozen.json"))) as Frozen;
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash) throw new Error("Edited frozen manifest");
  const db = new DatabaseSync(path.join(root, "study.sqlite"));
  const ledger = new StudyLedger(db, frozen.ceiling);
  const report = async (status: string) => {
    const charges = db
      .prepare("SELECT body,state,cost,observation,artifact FROM study_charges ORDER BY rowid")
      .all() as Array<{
      body: string;
      state: string;
      cost: string | null;
      observation: string | null;
      artifact: string | null;
    }>;
    const knownUsd = charges.reduce((s, c) => s + (c.cost ? JSON.parse(c.cost).providerUsd : 0), 0);
    const unknownReservedUsd = charges.reduce(
      (s, c) => s + (!c.cost ? JSON.parse(c.body).quote.providerUsd : 0),
      0,
    );
    const runs = charges.map((c) => ({
      state: c.state,
      ...JSON.parse(c.artifact ?? "{}"),
      observation: c.observation ? JSON.parse(c.observation) : null,
    }));
    const result = {
      schemaVersion: 1,
      status,
      updatedAt: new Date().toISOString(),
      frozenHash: hash,
      purpose: frozen.purpose,
      efficacyEstablished: false,
      planned: 22,
      recorded: runs.length,
      checkedPasses: runs.filter((r) => r.outcome === "pass").length,
      checkedFailures: runs.filter((r) => r.outcome === "task-failure").length,
      unresolvedOutcomes: runs.filter((r) => !["pass", "task-failure"].includes(r.outcome)).length,
      knownUsd,
      unknownReservedUsd,
      remainingAllocationUsd: frozen.ceiling.providerUsd - knownUsd - unknownReservedUsd,
      remainingOverallAuthorizationUsd:
        250 - inherited.knownUsd - inherited.unresolvedUsd - knownUsd - unknownReservedUsd,
      inherited,
      runs,
    };
    await fs.writeFile(path.join(root, "report.tmp"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(path.join(root, "report.tmp"), path.join(root, "report.json"));
    return {
      status,
      recorded: result.recorded,
      passes: result.checkedPasses,
      failures: result.checkedFailures,
      knownUsd,
      unknownReservedUsd,
    };
  };
  if (operation === "report") {
    const prior = (await read(path.join(root, "report.json")).catch(() => null)) as {
      status?: string;
    } | null;
    console.log(JSON.stringify(await report(prior?.status ?? "not-started")));
  } else {
    if (ledger.unresolved()) throw new Error("Unresolved costs/commands; no automatic retry");
    const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, hash, at: new Date().toISOString() }));
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    let status = "running";
    try {
      const fixture = BirdFixtureSchema.parse(await read(path.join(root, "fixture.json")));
      const configBytes = await fs.readFile(path.join(root, "state/bitterbot.json"));
      if (learningHash(fixture) !== frozen.fixtureHash || sha256(configBytes) !== frozen.configHash)
        throw new Error("Input/config drift");
      await probeStudyImage(image.id);
      let execution: ResearchBriefExecution | undefined, grade: BirdGrade | undefined;
      const protocol = await birdProtocol(fixture, sourceRoot, image.id, (_id, result) => {
        grade = result;
      });
      if (protocol.checkerHash !== frozen.checkerHash) throw new Error("Checker drift");
      const host = await createResearchBriefHost(
        JSON.parse(configBytes.toString()) as BitterbotConfig,
        "main",
        "bird-calibration",
        "development",
        image,
        {
          protocol,
          onExecution: async (e) => {
            execution = e;
          },
        },
      );
      if (learningHash(host.environment) !== frozen.environmentHash)
        throw new Error("Environment drift");
      for (const [index, slot] of frozen.schedule.entries()) {
        if (abort.signal.aborted) {
          status = "interrupted";
          break;
        }
        if (learningHash(await sources()) !== learningHash(frozen.sourceHashes))
          throw new Error("Execution source drift");
        if (ledger.startCommand(slot.id, { slot, hash }) !== undefined) continue;
        const item = fixture.cases.find((c) => c.id === slot.task)!;
        const task = { id: item.id, family: item.family, regression: false, input: item.input };
        try {
          ledger.reserve({
            id: slot.id,
            condition: "frozen",
            node: "a",
            phase: "selection",
            quote: host.quote(task),
          });
        } catch (e) {
          ledger.finishCommand(slot.id, { notExecuted: true, reason: String(e) });
          status = "budget-stopped";
          break;
        }
        execution = undefined;
        grade = undefined;
        console.log(JSON.stringify({ starting: index + 1, of: 22, slot }));
        let thrown = false;
        try {
          await host.execute(task, null, abort.signal);
        } catch {
          thrown = true;
        }
        const completed = execution as ResearchBriefExecution | undefined;
        const outcome = completed?.result.outcome ?? "infrastructure";
        const checked = ["pass", "task-failure"].includes(outcome);
        const artifact = {
          slot,
          runId: completed?.runId ?? null,
          outcome,
          grade: grade ?? null,
          inputHash: learningHash(item.input),
          packageHash: null,
          diagnostic: completed?.diagnostic ?? null,
          output: completed?.brief ?? null,
          markdown: completed?.markdown ?? null,
          thrown,
        };
        ledger.finish(
          slot.id,
          {
            taskId: slot.id,
            family: item.family,
            node: "a",
            user: "development",
            environment: frozen.environmentHash,
            condition: "frozen",
            phase: "selection",
            success: checked ? outcome === "pass" : null,
            checked,
            criticalFailure: false,
            retention: false,
            freshSession: true,
            elapsedHours: 0,
            newUser: false,
            cost: completed?.result.cost ?? null,
            tokens: completed?.tokens ?? 0,
            latencyMs: completed?.latencyMs ?? 0,
            humanUsefulness: null,
            humanRecommendation: null,
          },
          artifact,
        );
        ledger.finishCommand(slot.id, { outcome, runId: completed?.runId ?? null });
        console.log(
          JSON.stringify({ completed: index + 1, outcome, cost: completed?.result.cost ?? null }),
        );
        await report("running");
        if (
          !completed?.result.cost ||
          thrown ||
          ["checker-invalid", "infrastructure"].includes(outcome)
        ) {
          status = "unknown-or-infrastructure-stop";
          break;
        }
        if (abort.signal.aborted) {
          status = "interrupted";
          break;
        }
      }
      if (status === "running") status = "completed";
    } catch (error) {
      status = "stopped-error";
      console.error(error instanceof Error ? error.message : "Calibration error");
      process.exitCode = 1;
    } finally {
      console.log(JSON.stringify(await report(status)));
      await lock.close();
      await fs.unlink(path.join(root, "run.lock"));
    }
  }
  db.close();
}
