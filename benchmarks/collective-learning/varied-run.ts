/** Operator-only fixed difficulty calibration; no proposal, adoption or efficacy claim. */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ResearchBriefExecution } from "../../src/agents/skills/collective/research-brief.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import type { VariedGrade } from "./varied.js";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [operation, destination] = process.argv.slice(2);
if (
  !["prepare", "run", "report"].includes(operation) ||
  process.platform !== "linux" ||
  !destination ||
  path.dirname(destination) !== "/home/vicmg/.local/share/bitterbot-studies" ||
  !path.basename(destination).startsWith("varied-headroom-")
)
  throw new Error("Use prepare|run|report and a dedicated varied-headroom study root");
const root = path.resolve(destination);
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const [
  { learningHash, sha256 },
  { snapshotPackage, screenPackage },
  { compatibilityIssues },
  { createResearchBriefHost },
  { STATE_DIR },
  { SANDBOX_REGISTRY_PATH },
  { executionSources },
  { probeStudyImage },
  { StudyLedger },
  { VariedCaseSchema, variedProtocol, checkVaried },
] = await Promise.all([
  import("../../src/agents/skills/collective/contracts.js"),
  import("../../src/agents/skills/collective/package.js"),
  import("../../src/agents/skills/collective/compatibility.js"),
  import("../../src/agents/skills/collective/research-brief.js"),
  import("../../src/config/paths.js"),
  import("../../src/agents/sandbox/constants.js"),
  import("./deployment-driver.js"),
  import("./runtime-preflight.js"),
  import("./study-ledger.js"),
  import("./varied.js"),
]);
if (
  path.resolve(STATE_DIR) !== path.join(root, "state") ||
  path.resolve(SANDBOX_REGISTRY_PATH) !== path.join(root, "state/sandbox/containers.json")
)
  throw new Error("Nonisolated study initialization");
const read = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const image = {
  id: "sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535",
  architecture: "amd64",
};
const priorRoot = "/home/vicmg/.local/share/bitterbot-studies/sql-learning-20261112-v5";
const priorReport = path.join(
  repository,
  "reports/collective-learning/varied-headroom-20261113-v2/summary.json",
);
// Prior stopped calibration is charged in inherited totals; combined headroom cap remains $30.
const ceiling = { providerUsd: 27.9652335, toolCalls: 24 * 20, wallMs: 24 * 600000 };
const metadata = {
  name: "executable-task-procedure",
  description: "Implement and check a specified Python function",
  requirements: {
    platforms: ["linux"],
    tools: { read: "1", write: "1", exec: "1", python3: "3" },
    runtime: {},
    capabilities: [],
  },
};
const sources = async () => {
  const hashes = await executionSources();
  for (const file of ["varied_fixture.py", "varied_execute.py", "test_varied_fixture.py"]) {
    const rel = `benchmarks/collective-learning/benchmark-audit/${file}`;
    hashes[rel] = sha256(await fs.readFile(path.join(repository, rel)));
  }
  return hashes;
};
type Slot = { id: string; task: string; repeat: number };
type Freeze = {
  hash: string;
  sourceHashes: Record<string, string>;
  archiveHash: string;
  casesHash: string;
  configHash: string;
  checkerHash: string;
  environmentHash: string;
  packageHash: string;
  schedule: Slot[];
  ceiling: typeof ceiling;
  inherited: {
    authorizationUsd: number;
    knownUsd: number;
    unresolvedUsd: number;
    sourceSha256: string;
  };
  createdAt: string;
};

if (operation === "prepare") {
  await fs.mkdir(root, { mode: 0o700 });
  await promisify(execFile)(
    "python3",
    [
      path.join(repository, "benchmarks/collective-learning/benchmark-audit/varied_fixture.py"),
      path.join(root, "data"),
    ],
    { timeout: 120000 },
  );
  const fixture = (await read(path.join(root, "data/fixture.json"))) as { tasks: unknown[] };
  const cases = fixture.tasks.map((t) => VariedCaseSchema.parse(t));
  await probeStudyImage(image.id);
  const reference = (
    await fs.readFile(
      path.join(repository, "benchmarks/collective-learning/benchmark-audit/varied_fixture.py"),
      "utf8",
    )
  ).split("if __name__=='__main__':")[0];
  const qualification = [];
  for (const item of cases) {
    // This WSL host also serves the user's gateway. Keep sandbox qualification
    // sequential so compiler/daemon memory pressure cannot masquerade as a task failure.
    for (const suffix of ["", "_alt"]) {
      const grade = await checkVaried(
        item,
        `${reference}\nsolve=${item.family}${suffix}\n`,
        image.id,
      );
      if (grade.status !== "pass")
        throw new Error(`Container reference failed ${item.id}${suffix}: ${JSON.stringify(grade)}`);
      qualification.push({
        id: item.id,
        reference: suffix || "primary",
        grade: { ...grade, actual: undefined },
      });
    }
    for (const code of ["def solve(x): return {'status':'pass'}", "def solve(x): return None"]) {
      const grade = await checkVaried(item, code, image.id);
      if (grade.status !== "task-failure") throw new Error("Invalid candidate accepted");
    }
    console.log(JSON.stringify({ qualified: item.id, independentInputs: item.tests.length }));
  }
  const config = (await read(path.join(priorRoot, "state/bitterbot.json"))) as BitterbotConfig;
  const agentDir = path.join(root, "state/agents/main/agent"),
    workspace = path.join(root, "state/workspace");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  config.agents!.list = [{ ...config.agents!.list![0], agentDir, workspace }];
  config.skills!.collective!.budget = ceiling;
  for (const file of ["auth-profiles.json", "auth.json", "models.json"]) {
    const source = path.join(priorRoot, "state/agents/main/agent", file),
      stat = await fs.lstat(source).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
      throw new Error("Invalid credential source");
    await fs.writeFile(path.join(agentDir, file), await fs.readFile(source), {
      flag: "wx",
      mode: 0o600,
    });
  }
  await write(path.join(root, "state/bitterbot.json"), config);
  await fs.mkdir(path.join(root, "seed-package"));
  await fs.writeFile(
    path.join(root, "seed-package/SKILL.md"),
    "---\nname: executable-task-procedure\ndescription: Implement and check a specified Python function\n---\n\nRead the task contract and examples. Implement the requested function using the available standard library, test it locally, and write the required deliverables. Follow the task's stated output contract.\n",
    { flag: "wx" },
  );
  const snapshot = await snapshotPackage(path.join(root, "seed-package"), metadata);
  screenPackage(snapshot);
  const protocol = await variedProtocol(cases, image.id);
  const host = await createResearchBriefHost(
    config,
    "main",
    "development-node",
    "headroom",
    image,
    { protocol },
  );
  if (compatibilityIssues(snapshot.manifest, host.environment).length)
    throw new Error("Incompatible seed");
  const prior = (await read(priorReport)) as {
    knownUsd: number;
    unknownReservedUsd: number;
    inherited: { authorizationUsd: number; knownUsd: number; unresolvedUsd: number };
  };
  const inherited = {
    authorizationUsd: prior.inherited.authorizationUsd,
    knownUsd: prior.inherited.knownUsd + prior.knownUsd,
    unresolvedUsd: prior.inherited.unresolvedUsd + prior.unknownReservedUsd,
    sourceSha256: sha256(await fs.readFile(priorReport)),
  };
  if (
    inherited.authorizationUsd - inherited.knownUsd - inherited.unresolvedUsd <
    ceiling.providerUsd
  )
    throw new Error("Insufficient existing authorization");
  const schedule: Slot[] = [];
  for (let repeat = 0; repeat < 2; repeat++)
    for (const c of cases.toSorted((a, b) =>
      learningHash(`varied-headroom:${repeat}:${a.id}`).localeCompare(
        learningHash(`varied-headroom:${repeat}:${b.id}`),
      ),
    ))
      schedule.push({ id: `${c.id}:${repeat}`, task: c.id, repeat });
  const sourceHashes = await sources();
  await fs.writeFile(
    path.join(root, "source-files.txt"),
    Object.keys(sourceHashes).join("\n") + "\n",
    { flag: "wx" },
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
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    purpose: "Six-mechanism difficulty calibration only",
    model: config.skills!.collective!.validationModel,
    sourceHashes,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    casesHash: learningHash(cases),
    configHash: sha256(await fs.readFile(path.join(root, "state/bitterbot.json"))),
    checkerHash: protocol.checkerHash,
    environmentHash: learningHash(host.environment),
    packageHash: snapshot.packageHash,
    schedule,
    ceiling,
    inherited,
  };
  await write(path.join(root, "cases.json"), cases);
  await write(path.join(root, "container-qualification.json"), qualification);
  await write(path.join(root, "frozen.json"), { ...body, hash: learningHash(body) });
  await write(path.join(root, "payload-review.json"), {
    ...body,
    sourceHashes: undefined,
    frozenHash: learningHash(body),
    taskPrompt: protocol.prompt,
    maximumCalls: 24,
    quote: host.quote(host.tasks[0]),
    publicInputs: cases.map((c) => ({ id: c.id, input: c.input })),
    startingPackage: snapshot.manifest,
    headroomRule: {
      tasks: 12,
      repeats: 2,
      eligible:
        "At least 3 of 24 checked failures spanning at least two families, and at least 3 successes; no unresolved/infrastructure runs. Decision only qualifies a NEW independently frozen learning diagnostic, never efficacy.",
      selection:
        "Keep all six families in subsequent comparison; do not choose treatment winners. This panel and all its outcomes remain development-only.",
    },
    disclosure:
      "Authored public contracts/examples, seed package and standard tool prompts/results only. No private source documents or production memory.",
    stops: [
      "Fixed 24 task attempts completed",
      "Budget exhaustion",
      "Unknown costs",
      "Infrastructure, invalid checker or interruption",
      "Source, package, input or environment drift",
    ],
    automaticRetries: false,
    publicMesh: false,
    activation: false,
    efficacyEstablished: false,
  });
  console.log(
    JSON.stringify({
      prepared: root,
      hash: learningHash(body),
      calls: 24,
      capUsd: ceiling.providerUsd,
      paidCalls: 0,
    }),
  );
} else {
  const frozen = (await read(path.join(root, "frozen.json"))) as Freeze;
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash) throw new Error("Manifest drift");
  const db = new DatabaseSync(path.join(root, "study.sqlite")),
    ledger = new StudyLedger(db, frozen.ceiling);
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
    const knownUsd = charges.reduce((n, c) => n + (c.cost ? JSON.parse(c.cost).providerUsd : 0), 0),
      unknownReservedUsd = charges.reduce(
        (n, c) => n + (c.cost ? 0 : JSON.parse(c.body).quote.providerUsd),
        0,
      );
    const result = {
      schemaVersion: 1,
      status,
      updatedAt: new Date().toISOString(),
      frozenHash: hash,
      planned: 24,
      knownUsd,
      unknownReservedUsd,
      inherited: frozen.inherited,
      remainingOverallAuthorizationUsd:
        frozen.inherited.authorizationUsd -
        frozen.inherited.knownUsd -
        frozen.inherited.unresolvedUsd -
        knownUsd -
        unknownReservedUsd,
      efficacyEstablished: false,
      runs: charges.map((c) => ({
        state: c.state,
        ...JSON.parse(c.artifact ?? "{}"),
        observation: c.observation ? JSON.parse(c.observation) : null,
      })),
    };
    await fs.writeFile(path.join(root, "report.tmp"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(path.join(root, "report.tmp"), path.join(root, "report.json"));
    return { status, recorded: charges.length, knownUsd, unknownReservedUsd };
  };
  if (operation === "report") {
    console.log(
      JSON.stringify(
        await report(((await read(path.join(root, "report.json"))) as { status: string }).status),
      ),
    );
  } else {
    if (db.prepare("SELECT 1 FROM study_commands LIMIT 1").get())
      throw new Error("Never automatically resume or retry a started study");
    const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, hash, at: new Date().toISOString() }));
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    let status = "running";
    try {
      const cases = ((await read(path.join(root, "cases.json"))) as unknown[]).map((c) =>
        VariedCaseSchema.parse(c),
      );
      const configBytes = await fs.readFile(path.join(root, "state/bitterbot.json"));
      if (learningHash(cases) !== frozen.casesHash || sha256(configBytes) !== frozen.configHash)
        throw new Error("Input/config drift");
      const config = JSON.parse(configBytes.toString()) as BitterbotConfig;
      const snapshot = await snapshotPackage(path.join(root, "seed-package"), metadata);
      if (snapshot.packageHash !== frozen.packageHash) throw new Error("Package drift");
      let execution: ResearchBriefExecution | undefined, grade: VariedGrade | undefined;
      const protocol = await variedProtocol(cases, image.id, (g) => {
        grade = g;
      });
      if (protocol.checkerHash !== frozen.checkerHash) throw new Error("Checker drift");
      await probeStudyImage(image.id);
      const host = await createResearchBriefHost(
        config,
        "main",
        "development-node",
        "headroom",
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
        const item = cases.find((c) => c.id === slot.task)!;
        const task = { id: item.id, family: item.family, regression: false, input: item.input };
        ledger.startCommand(slot.id, { hash, slot, packageHash: snapshot.packageHash });
        try {
          ledger.reserve({
            id: slot.id,
            condition: "frozen",
            node: "a",
            phase: "selection",
            quote: host.quote(task),
          });
        } catch {
          ledger.finishCommand(slot.id, { notExecuted: true, reason: "budget" });
          status = "budget-stopped";
          break;
        }
        execution = undefined;
        grade = undefined;
        let thrown = false;
        console.log(JSON.stringify({ starting: index + 1, total: 24, slot }));
        try {
          await host.execute(task, snapshot, abort.signal);
        } catch {
          thrown = true;
        }
        const completed = execution as ResearchBriefExecution | undefined;
        const outcome = completed?.result.outcome ?? "infrastructure",
          checked = ["pass", "task-failure"].includes(outcome);
        const artifact = {
          slot,
          runId: completed?.runId ?? null,
          outcome,
          grade: grade ?? null,
          packageHash: snapshot.packageHash,
          inputHash: learningHash(item.input),
          accessedFiles: completed?.result.accessedFiles ?? [],
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
        ledger.finishCommand(slot.id, { completed: true });
        console.log(
          JSON.stringify({
            ...(await report("running")),
            outcome,
            passedInputs: (grade as VariedGrade | undefined)?.passed,
          }),
        );
        if (!completed?.result.cost || !checked) {
          status = !completed?.result.cost ? "unknown-cost-stop" : `stopped-${outcome}`;
          break;
        }
      }
      if (status === "running") status = "completed";
    } catch (error) {
      status = "stopped-error";
      console.error(error instanceof Error ? error.message : "Study error");
    } finally {
      console.log(JSON.stringify(await report(status)));
      await lock.close();
      await fs.unlink(path.join(root, "run.lock"));
      db.close();
    }
    if (status !== "completed") process.exitCode = 1;
  }
}
