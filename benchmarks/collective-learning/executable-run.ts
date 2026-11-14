/** Operator-only executable-learning vertical slice. No production activation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PackageSnapshot } from "../../src/agents/skills/collective/contracts.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import type {
  LearningAdapter,
  LearningCandidate,
} from "../../src/memory/procedural-learning-contract.js";
import {
  copyInputs,
  dockerPython,
  gradeOutput,
  inputHashes,
  type Grade,
} from "./executable-runtime.js";

const [operation, destination] = process.argv.slice(2);
if (
  process.platform !== "linux" ||
  !destination ||
  path.dirname(destination) !== "/home/vicmg/.local/share/bitterbot-studies" ||
  !/^executable-learning-\d{8}-v\d+$/.test(path.basename(destination)) ||
  ![
    "prepare",
    "acquire",
    "qualify-source",
    "reuse-source",
    "qualify-recipient",
    "reuse-recipient",
    "compare",
    "control",
    "report",
  ].includes(operation)
)
  throw new Error("Expected isolated executable-learning study and explicit operation");
const root = path.resolve(destination),
  repo = fileURLToPath(new URL("../..", import.meta.url));
const suite = path.join(repo, "research/collective-learning/executable-learning");
const exportDir = path.join(repo, "reports/collective-learning", path.basename(root));
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const [
  { learningHash, sha256 },
  { snapshotPackage, screenPackage },
  { CollectiveSkillStore },
  { StudyLedger },
  { executionSources },
  { isolatedPackageConfig },
  { withPackageTrial },
  { ProceduralLearningStore },
  { ProceduralLearning },
  { VerifiedWorkflowReuse },
  { STATE_DIR },
  { SANDBOX_REGISTRY_PATH },
] = await Promise.all([
  import("../../src/agents/skills/collective/contracts.js"),
  import("../../src/agents/skills/collective/package.js"),
  import("../../src/agents/skills/collective/store.js"),
  import("./study-ledger.js"),
  import("./deployment-driver.js"),
  import("../../src/agents/skills/collective/isolated-config.js"),
  import("../../src/agents/skills/collective/execution-context.js"),
  import("../../src/memory/procedural-learning-store.js"),
  import("../../src/memory/procedural-learning.js"),
  import("../../src/memory/verified-workflow-reuse.js"),
  import("../../src/config/paths.js"),
  import("../../src/agents/sandbox/constants.js"),
]);
assert.equal(STATE_DIR, path.join(root, "state"));
assert.equal(SANDBOX_REGISTRY_PATH, path.join(root, "state/sandbox/containers.json"));
const exec = promisify(execFile);
const read = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, "utf8")) as T;
const write = async (file: string, body: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
};
const protocol = await read<{
  model: string;
  image: string;
  campaignCapUsd: number;
  taskPrompt: string;
  builderPrompt: string;
  textBuilderPrompt: string;
}>(path.join(suite, "protocol.json"));
const contract = await read<Record<string, unknown>>(path.join(suite, "contract.json"));
type Fixture = {
  id: string;
  partition: string;
  layout: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};
const inventory = (
  await read<{ partitions: Fixture[] }>(path.join(suite, "fixtures/inventory.json"))
).partitions;
const cases = (partition: string) => inventory.filter((c) => c.partition === partition);
const caseDir = (id: string) => {
  const c = inventory.find((c) => c.id === id);
  if (!c) throw new Error("Unknown host fixture");
  return path.join(suite, "fixtures", c.partition, c.id);
};
const metadata = {
  name: "docx-placeholder-workflow",
  description: "Fill bounded DOCX templates while preserving content placement",
  requirements: {
    platforms: ["linux"],
    tools: { python3: "3", read: "1", write: "1", exec: "1" },
    capabilities: [],
    runtime: { image: protocol.image },
  },
};
const scope = {
  tool: "docx-workflow",
  version: "1",
  operation: "fill-placeholders",
  contractHash: learningHash(contract),
};
const cap = { providerUsd: protocol.campaignCapUsd, toolCalls: 2000, wallMs: 18000000 };
type Cost = { providerUsd: number; toolCalls: number; wallMs: number };
type ModelRecord = {
  id: string;
  kind: string;
  caseId: string | null;
  runId: string;
  workspace: string;
  startedAt: number;
  cost: Cost | null;
  tokens: number;
  grade: Grade | null;
  reads: string[];
  aborted: boolean;
  inputUnchanged: boolean;
  outputHash: string | null;
};
type Freeze = {
  hash: string;
  sources: Record<string, string>;
  image: string;
  configHash: string;
  modelDefinitionHash: string;
  rates: Record<string, number>;
  quote: Cost;
  inherited: { knownUsd: number; reserveUsd: number; remainingUsd: number };
  createdAt: string;
  priorFailure: unknown;
};

async function sources() {
  const result = await executionSources();
  for (const relative of await fs.readdir(suite, { recursive: true })) {
    if (relative.split(path.sep).includes("__pycache__") || relative.endsWith("close-prior.mjs"))
      continue;
    const file = path.join(suite, relative);
    if (!(await fs.stat(file)).isFile()) continue;
    result[path.relative(repo, file)] = sha256(await fs.readFile(file));
  }
  return result;
}
async function cleanupModelWorkspace(workspace: string) {
  const registry = await read<{ entries: Array<{ containerName: string }> }>(
    SANDBOX_REGISTRY_PATH,
  ).catch(() => ({ entries: [] }));
  for (const item of registry.entries) {
    const response = await exec("docker", ["inspect", item.containerName], {
      timeout: 10000,
    }).catch(() => null);
    if (!response) continue;
    const info = JSON.parse(response.stdout)[0];
    if (
      info.Image !== protocol.image ||
      info.Config.Labels["bitterbot.sandbox"] !== "1" ||
      !info.Mounts.some((m: { Source: string }) => m.Source === workspace)
    )
      continue;
    if (
      info.Mounts.some(
        (m: { Source: string }) => m.Source !== workspace && !m.Source.startsWith(workspace + "/"),
      )
    )
      throw new Error("Unexpected study model mount");
    await exec("docker", ["rm", "-f", info.Id], { timeout: 15000 });
  }
}

if (operation === "prepare") {
  for (const platform of ["windows", "linux"]) {
    const qualification = await read<{
      total: number;
      passed: number;
      sources: Record<string, string>;
    }>(path.join(exportDir, "checker-qualification-" + platform + ".json"));
    assert.equal(qualification.passed, 51);
    assert.equal(qualification.total, 51);
    for (const [name, hash] of Object.entries(qualification.sources))
      assert.equal(sha256(await fs.readFile(path.join(suite, name))), hash);
  }
  for (const fixture of inventory)
    for (const file of fixture.files) {
      const raw = await fs.readFile(path.join(suite, "fixtures", file.path));
      assert.equal(sha256(raw), file.sha256);
      assert.equal(raw.length, file.bytes);
    }
  const oldReportDir = path.join(
    repo,
    "reports/collective-learning/practical-learning-20261113-v3",
  );
  const stopped = await read<{
    budget: { cumulativeKnownUsd: number; priorUnresolvedReserveUsd: number; remainingUsd: number };
  }>(path.join(oldReportDir, "stopped-readout.json"));
  assert(stopped.budget.remainingUsd >= cap.providerUsd);
  await fs.mkdir(root, { mode: 0o700 });
  const priorRoot = "/home/vicmg/.local/share/bitterbot-studies/practical-learning-20261113-v3";
  const config = await read<BitterbotConfig>(path.join(priorRoot, "state/bitterbot.json"));
  const template = config.agents!.list![0],
    sourceAgent = template.agentDir!;
  const agentDir = path.join(root, "state/agents/builder/agent"),
    workspace = path.join(root, "state/workspaces/builder");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  config.agents!.list = [
    {
      ...template,
      id: "builder",
      agentDir,
      workspace,
      sandbox: {
        ...template.sandbox,
        docker: { ...template.sandbox?.docker, image: protocol.image },
      },
    },
  ];
  config.skills!.collective!.budget = cap;
  config.skills!.collective!.validationModel = protocol.model;
  for (const name of ["auth-profiles.json", "auth.json", "models.json"]) {
    const file = path.join(sourceAgent, name),
      stat = await fs.lstat(file).catch(() => null);
    if (!stat) continue;
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 4 * 1024 * 1024,
    );
    await fs.writeFile(path.join(agentDir, name), await fs.readFile(file), {
      flag: "wx",
      mode: 0o600,
    });
  }
  await write(path.join(root, "state/bitterbot.json"), config);
  const { resolveModel } = await import("../../src/agents/embedded-runner/model.js");
  const model = resolveModel(
    "anthropic",
    protocol.model.slice(protocol.model.indexOf("/") + 1),
    agentDir,
    config,
  ).model;
  assert(model?.cost && Object.values(model.cost).every((n) => Number.isFinite(n) && n >= 0));
  const quote = {
    providerUsd:
      (model.cost.input + model.cost.cacheRead + model.cost.cacheWrite) * 0.4 +
      model.cost.output * 0.1,
    toolCalls: 21,
    wallMs: 450000,
  };
  assert(quote.providerUsd <= cap.providerUsd);
  const prior = await read<{
    runs: Array<{
      id: string;
      artifactDirectory: string;
      artifacts: Array<{ name: string; sha256: string }>;
    }>;
  }>(path.join(oldReportDir, "report.json"));
  const failure = prior.runs.find((r) => r.id === "r1:final-local:offer-letter-generator-5:a")!;
  const artifact = path.join(oldReportDir, failure.artifactDirectory, "offer_letter_filled.docx");
  assert.equal(sha256(await fs.readFile(artifact)), failure.artifacts[0].sha256);
  await fs.mkdir(path.join(root, "prior"));
  await fs.copyFile(artifact, path.join(root, "prior/failed-output.docx"), 1);
  const priorFailure = {
    source: "Stopped practical v3; former held-out case is now development evidence only",
    sourceExecution: failure.id,
    originalArtifactSha256: failure.artifacts[0].sha256,
    observation: await read(path.join(oldReportDir, "host-review/local-document-failure.json")),
    reclassifiedAsCurrentReceipt: false,
  };
  const pinnedSources = await sources();
  const sourceList = path.join(root, "source-files.txt");
  await fs.writeFile(sourceList, Object.keys(pinnedSources).join("\n") + "\n", { flag: "wx" });
  await exec(
    "tar",
    ["-czf", path.join(root, "execution-source.tar.gz"), "-C", repo, "-T", sourceList],
    { timeout: 120000 },
  );
  const frozenBody = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    protocol,
    contract,
    sources: pinnedSources,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    image: protocol.image,
    configHash: learningHash(config),
    modelDefinitionHash: learningHash(model),
    rates: model.cost,
    quote,
    inherited: {
      knownUsd: stopped.budget.cumulativeKnownUsd,
      reserveUsd: stopped.budget.priorUnresolvedReserveUsd,
      remainingUsd: stopped.budget.remainingUsd,
    },
    priorFailure,
  };
  const frozen = { ...frozenBody, hash: learningHash(frozenBody) };
  await write(path.join(root, "frozen.json"), frozen);
  await write(path.join(exportDir, "frozen.json"), frozen);
  console.log(
    JSON.stringify({
      prepared: true,
      hash: frozen.hash,
      quote,
      capUsd: cap.providerUsd,
      providerCalls: 0,
    }),
  );
  process.exit(0);
}

const frozen = await read<Freeze>(path.join(root, "frozen.json"));
const { hash, ...frozenBody } = frozen;
assert.equal(learningHash(frozenBody), hash);
assert.deepEqual(await sources(), frozen.sources, "Execution sources changed after freeze");
const config = await read<BitterbotConfig>(path.join(root, "state/bitterbot.json"));
assert.equal(learningHash(config), frozen.configHash);
const db = new DatabaseSync(path.join(root, "ledger.sqlite")),
  ledger = new StudyLedger(db, cap);
db.exec("CREATE TABLE IF NOT EXISTS executable_records (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
const allRecords = () =>
  (
    db.prepare("SELECT body FROM executable_records ORDER BY rowid").all() as { body: string }[]
  ).map((r) => JSON.parse(r.body) as ModelRecord);
const totals = () => {
  const charges = db.prepare("SELECT body,cost,state FROM study_charges").all() as Array<{
    body: string;
    cost: string | null;
    state: string;
  }>;
  return {
    knownUsd: charges.reduce((n, r) => n + (r.cost ? JSON.parse(r.cost).providerUsd : 0), 0),
    heldUsd: charges.reduce((n, r) => n + (r.cost ? 0 : JSON.parse(r.body).quote.providerUsd), 0),
    unresolved: charges.filter((r) => r.state !== "settled").length,
  };
};
let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
if (operation !== "report") lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
async function storePackage(kind: string, snapshot: PackageSnapshot) {
  screenPackage(snapshot);
  const store = new CollectiveSkillStore(db, path.join(root, "packages"));
  await store.install(snapshot);
  await write(path.join(root, kind + "-package.json"), {
    packageHash: snapshot.packageHash,
    manifest: snapshot.manifest,
    omitted: snapshot.omitted,
  });
}
async function modelRun(
  id: string,
  kind: "baseline" | "text" | "builder" | "text-builder",
  fixture?: Fixture,
  textPackage?: PackageSnapshot,
): Promise<ModelRecord> {
  const old = ledger.startCommand(id, {
    kind,
    caseId: fixture?.id ?? null,
    freeze: hash,
    textPackage: textPackage?.packageHash ?? null,
  });
  if (old) return old as ModelRecord;
  const current = totals();
  if (current.unresolved || current.knownUsd + frozen.quote.providerUsd > cap.providerUsd)
    throw new Error("Campaign budget unavailable or unresolved");
  const phase =
    fixture?.partition === "evaluation" ? "final" : fixture ? "acquisition" : "proposal";
  ledger.reserve({ id, condition: "local", node: "a", phase, quote: frozen.quote });
  const runId = crypto.randomUUID(),
    workspace = path.join(root, "workspaces", runId),
    startedAt = Date.now();
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await write(path.join(workspace, "contract.json"), contract);
  if (fixture) {
    await copyInputs(caseDir(fixture.id), path.join(workspace, "inputs"));
    await fs.mkdir(path.join(workspace, "output"));
  } else {
    await fs.mkdir(path.join(workspace, "candidate"));
    await write(path.join(workspace, "prior-failure.json"), frozen.priorFailure);
    await fs.copyFile(
      path.join(root, "prior/failed-output.docx"),
      path.join(workspace, "prior-failed-output.docx"),
    );
    const records = allRecords().filter(
      (r) => r.kind === "baseline" && cases("development").some((c) => c.id === r.caseId),
    );
    assert.equal(records.length, 3);
    await write(
      path.join(workspace, "observations.json"),
      records.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        grade: r.grade,
        cost: r.cost,
        inputUnchanged: r.inputUnchanged,
      })),
    );
    for (const c of cases("development")) {
      const target = path.join(workspace, "development", c.id);
      await copyInputs(caseDir(c.id), target);
      const record = records.find((r) => r.caseId === c.id)!;
      await fs
        .copyFile(
          path.join(record.workspace, "output/offer_letter_filled.docx"),
          path.join(target, "observed-output.docx"),
        )
        .catch(() => undefined);
    }
  }
  if (textPackage) {
    await fs.mkdir(path.join(workspace, "skill"));
    for (const [name, bytes] of textPackage.files)
      await fs.writeFile(path.join(workspace, "skill", name), bytes);
  }
  const context = {
    workspace,
    packageFiles: new Set(textPackage ? textPackage.files.keys() : []),
    reads: new Set<string>(),
    toolCalls: 0,
    maxToolCalls: 20,
  };
  const before = fixture ? await inputHashes(path.join(workspace, "inputs")) : null;
  let record: ModelRecord;
  let observedCost: Cost | null = null,
    observedTokens = 0,
    executionError = false;
  try {
    const { runEmbeddedPiAgent } = await import("../../src/agents/embedded-runner/run.js");
    const prompt =
      kind === "builder"
        ? protocol.builderPrompt
        : kind === "text-builder"
          ? protocol.textBuilderPrompt
          : protocol.taskPrompt +
            (textPackage
              ? " Read skill/SKILL.md before acting and use that procedure where applicable."
              : "");
    await write(path.join(root, "payloads", id + ".json"), {
      id,
      prompt,
      fixture: fixture?.id ?? null,
      packageHash: textPackage?.packageHash ?? null,
      visibleFiles: (await fs.readdir(workspace, { recursive: true })).filter(
        (n) => !n.endsWith("/"),
      ),
      checkerVisible: false,
      referenceAnswersVisible: false,
    });
    const result = await withPackageTrial(context, () =>
      runEmbeddedPiAgent({
        agentId: "builder",
        agentDir: config.agents!.list![0].agentDir!,
        sessionId: runId,
        sessionKey: "agent:builder:executable-study:" + runId,
        sessionFile: path.join(root, "sessions", runId + ".jsonl"),
        workspaceDir: workspace,
        config: isolatedPackageConfig(
          config,
          "builder",
          workspace,
          protocol.model,
          Boolean(textPackage),
          protocol.image,
        ),
        provider: "anthropic",
        model: protocol.model.slice(protocol.model.indexOf("/") + 1),
        runId,
        timeoutMs: 300000,
        abortSignal: abort.signal,
        disableMessageTool: true,
        senderIsOwner: false,
        skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
        prompt,
      }),
    );
    const usage = result.meta.agentMeta?.usage;
    const known =
      usage &&
      result.meta.agentMeta?.provider === "anthropic" &&
      result.meta.agentMeta?.model === protocol.model.slice(protocol.model.indexOf("/") + 1);
    const cost = known
      ? {
          providerUsd:
            ((usage.input ?? 0) * frozen.rates.input +
              (usage.output ?? 0) * frozen.rates.output +
              (usage.cacheRead ?? 0) * frozen.rates.cacheRead +
              (usage.cacheWrite ?? 0) * frozen.rates.cacheWrite) /
            1000000,
          toolCalls: context.toolCalls,
          wallMs: Date.now() - startedAt,
        }
      : null;
    observedCost = cost;
    observedTokens = usage
      ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      : 0;
    const output = path.join(workspace, "output/offer_letter_filled.docx");
    const inputUnchanged =
      !fixture ||
      learningHash(before) === learningHash(await inputHashes(path.join(workspace, "inputs")));
    const checked =
      fixture && !result.meta.aborted
        ? await gradeOutput(protocol.image, suite, caseDir(fixture.id), output, abort.signal)
        : null;
    if (cost && checked) {
      cost.wallMs += checked.wallMs;
      cost.toolCalls += 1;
    }
    const grade = checked?.grade ?? null;
    if (grade && !inputUnchanged) {
      grade.status = "task-failure";
      grade.issues.push("input-modified");
    }
    record = {
      id,
      kind,
      caseId: fixture?.id ?? null,
      runId,
      workspace,
      startedAt,
      cost,
      tokens: usage
        ? (usage.input ?? 0) +
          (usage.output ?? 0) +
          (usage.cacheRead ?? 0) +
          (usage.cacheWrite ?? 0)
        : 0,
      grade,
      reads: [...context.reads],
      aborted: Boolean(result.meta.aborted),
      inputUnchanged,
      outputHash: fixture
        ? await fs
            .readFile(output)
            .then(sha256)
            .catch(() => null)
        : null,
    };
  } catch (error) {
    executionError = true;
    record = {
      id,
      kind,
      caseId: fixture?.id ?? null,
      runId,
      workspace,
      startedAt,
      cost: observedCost,
      tokens: observedTokens,
      grade: null,
      reads: [...context.reads],
      aborted: abort.signal.aborted,
      inputUnchanged: false,
      outputHash: null,
    };
    await write(path.join(root, "errors", id + ".json"), {
      name: (error as Error).name,
      message: (error as Error).message.slice(0, 300),
    });
  }
  ledger.finish(
    id,
    {
      taskId: id,
      family: scope.tool,
      node: "a",
      user: "authored-fixture",
      environment: protocol.image,
      condition: "local",
      phase,
      success: record.grade ? record.grade.status === "pass" : null,
      checked: Boolean(record.grade && record.grade.status !== "checker-invalid"),
      criticalFailure: false,
      retention: false,
      freshSession: true,
      elapsedHours: 0,
      newUser: false,
      cost: record.cost,
      tokens: record.tokens,
      latencyMs: Date.now() - startedAt,
      humanUsefulness: null,
      humanRecommendation: null,
    },
    record,
  );
  db.prepare("INSERT INTO executable_records VALUES (?,?)").run(id, JSON.stringify(record));
  ledger.finishCommand(id, record);
  await cleanupModelWorkspace(workspace);
  console.log(
    JSON.stringify({
      id,
      grade: record.grade?.status,
      runKnownUsd: record.cost?.providerUsd,
      ...totals(),
    }),
  );
  if (
    executionError ||
    !record.cost ||
    record.aborted ||
    record.grade?.status === "checker-invalid" ||
    record.cost.providerUsd > frozen.quote.providerUsd
  )
    throw new Error(
      "Model run incomplete, unresolved, invalid checker or cost overrun; inspect journal",
    );
  return record;
}

async function workflow(node: "source" | "recipient", qualification: boolean) {
  const packageInfo = await read<{ packageHash: string }>(
    path.join(root, "executable-package.json"),
  );
  const packageStore = new CollectiveSkillStore(db, path.join(root, "packages"));
  const snapshot = await packageStore.read(packageInfo.packageHash);
  const nodeRoot = path.join(root, node);
  await fs.mkdir(nodeRoot, { recursive: true });
  const learningDb = new DatabaseSync(path.join(nodeRoot, "learning.sqlite"));
  const localPackages = new CollectiveSkillStore(learningDb, path.join(nodeRoot, "store"));
  await localPackages.install(snapshot);
  const store = new ProceduralLearningStore(learningDb, {
    mode: "shadow",
    executionBudget: { providerUsd: cap.providerUsd, toolCalls: 200, wallMs: 3600000 },
  });
  const learning = new ProceduralLearning(store),
    reuse = new VerifiedWorkflowReuse(learning);
  const input = (c: Fixture) => ({
    caseId: c.id,
    files: c.files
      .filter((f) => !f.path.endsWith("reference.docx"))
      .map((f) => ({ name: path.basename(f.path), sha256: f.sha256 })),
  });
  const checkerHash = learningHash(
    Object.fromEntries(
      Object.entries(frozen.sources).filter(
        ([name]) =>
          name.endsWith("checker.py") ||
          name.includes("/oracle/") ||
          name.endsWith("executable-runtime.ts"),
      ),
    ),
  );
  const adapter: LearningAdapter = {
    id: "docx-executable-v1",
    scope,
    isolation: "sandbox",
    verifierHash: checkerHash,
    qualificationCases: cases("qualification").map(input),
    quote: () => ({ providerUsd: 0, toolCalls: 2, wallMs: 150000 }),
    async execute(program, request, signal) {
      const spec = JSON.parse(program) as { packageHash: string; entrypoint: string };
      assert.equal(spec.packageHash, snapshot.packageHash);
      assert.equal(spec.entrypoint, "helpers/fill_docx.py");
      const fixture = inventory.find((c) => learningHash(input(c)) === learningHash(request));
      if (!fixture) throw new Error("Invalid workflow input");
      const exact = await localPackages.read(spec.packageHash);
      const runId = crypto.randomUUID(),
        runRoot = path.join(nodeRoot, "runs", runId);
      await fs.mkdir(runRoot, { recursive: true });
      await copyInputs(caseDir(fixture.id), path.join(runRoot, "inputs"));
      await fs.mkdir(path.join(runRoot, "output"));
      const execution = await dockerPython(
        protocol.image,
        [
          {
            source: path.join(localPackages.directory(spec.packageHash), "content"),
            target: "/skill",
          },
          { source: path.join(runRoot, "inputs"), target: "/inputs" },
          { source: path.join(runRoot, "output"), target: "/output", write: true },
        ],
        [
          "/skill/" + spec.entrypoint,
          "--template",
          "/inputs/offer_letter_template.docx",
          "--data",
          "/inputs/employee_data.json",
          "--output",
          "/output/offer_letter_filled.docx",
        ],
        signal,
      );
      await localPackages.read(spec.packageHash);
      const outputHash = await fs
        .readFile(path.join(runRoot, "output/offer_letter_filled.docx"))
        .then(sha256)
        .catch(() => null);
      const record = {
        runId,
        node,
        caseId: fixture.id,
        packageHash: spec.packageHash,
        helperSha256: sha256(exact.files.get(spec.entrypoint)!),
        inputHashes: await inputHashes(path.join(runRoot, "inputs")),
        outputHash,
        ...execution,
      };
      await write(path.join(runRoot, "invocation.json"), record);
      return {
        output: { runRoot, exitCode: execution.exitCode, outputHash },
        cost: { providerUsd: 0, toolCalls: 1, wallMs: execution.wallMs },
      };
    },
    async verify(request, output, signal) {
      const fixture = inventory.find((c) => learningHash(input(c)) === learningHash(request))!;
      const execution = output as { runRoot: string; exitCode: number; outputHash: string | null };
      assert(execution.runRoot.startsWith(nodeRoot + "/runs/"));
      const checked = await gradeOutput(
        protocol.image,
        suite,
        caseDir(fixture.id),
        path.join(execution.runRoot, "output/offer_letter_filled.docx"),
        signal,
      );
      if (execution.exitCode !== 0) {
        checked.grade.status = "task-failure";
        checked.grade.issues.push("helper-nonzero-exit");
      }
      await write(path.join(execution.runRoot, "verification.json"), checked);
      return {
        passed: checked.grade.status === "pass",
        classification:
          checked.grade.status === "pass"
            ? "pass"
            : checked.grade.status === "checker-invalid"
              ? "verifier-invalid"
              : "candidate-failure",
        cost: { providerUsd: 0, toolCalls: 1, wallMs: checked.wallMs },
      };
    },
  };
  reuse.register({
    adapter,
    inputContractHash: scope.contractHash,
    accepts: (value) => inventory.some((c) => learningHash(input(c)) === learningHash(value)),
  });
  let candidate: LearningCandidate;
  if (node === "source") {
    const episodes = allRecords().filter(
      (r) => r.kind === "baseline" && cases("development").some((c) => c.id === r.caseId),
    );
    for (const record of episodes)
      store.recordEpisode({
        id: record.id,
        scope,
        outcome:
          record.grade?.status === "pass"
            ? "success"
            : record.grade?.status === "task-failure"
              ? "failure"
              : "unknown",
        traceHash: learningHash(record),
        cost: record.cost,
        partition: "acquisition",
        sharing: "shareable",
        occurredAt: record.startedAt,
      });
    const existing = await read<LearningCandidate>(
      path.join(root, "workflow-candidate.json"),
    ).catch(() => null);
    candidate = existing ?? {
      schemaVersion: 1,
      scope,
      lesson:
        "Execute the generated DOCX workflow inside its pinned sandbox; return output only after host verification.",
      adapter: adapter.id,
      program: JSON.stringify({
        packageHash: snapshot.packageHash,
        entrypoint: "helpers/fill_docx.py",
      }),
      counterexamples: [
        "Text boxes, tracked changes, macros, cross-paragraph tokens and visual equivalence are outside this contract.",
      ],
      parents: [],
      sourceEpisodes: episodes.map((e) => e.id),
      origin: "experience",
      sharing: "shareable",
      expiresAt: Date.now() + 7 * 86400000,
    };
    if (!existing) await write(path.join(root, "workflow-candidate.json"), candidate);
  } else
    candidate = {
      ...(await read<LearningCandidate>(path.join(root, "workflow-candidate.json"))),
      origin: "peer",
    };
  const entry = store.propose(candidate, node === "recipient");
  // Source acquisition costs are visible here, but the authoritative group ledger counts them once.
  const request = {
    scope,
    candidate: entry.hash,
    shadowEvaluation: true as const,
    budget: { providerUsd: cap.providerUsd, toolCalls: 200, wallMs: 3600000 },
    predictedSuccess: 0.5,
  };
  const availableBefore = reuse.available(scope);
  let outcomes: unknown[];
  if (qualification) {
    assert.equal(
      availableBefore.length,
      0,
      "Qualification is never imported or implicitly repeated",
    );
    const passed = await learning.qualify(request);
    outcomes = [{ passed, availableAfter: reuse.available(scope) }];
  } else {
    assert(availableBefore.includes(entry.hash), "No qualification survived restart");
    outcomes = [];
    for (const fixture of cases("evaluation")) {
      const result = await reuse.reuse({
        ...request,
        requestId: node + ":evaluation:" + fixture.id,
        partition: "held-out",
        input: input(fixture),
      });
      outcomes.push({ caseId: fixture.id, ...result });
      console.log(JSON.stringify({ node, caseId: fixture.id, disposition: result.disposition }));
      if (result.disposition === "stopped")
        throw new Error("Workflow infrastructure or verifier invalid");
    }
  }
  await write(path.join(root, operation + ".json"), {
    operation,
    pid: process.pid,
    recordedAt: new Date().toISOString(),
    packageHash: snapshot.packageHash,
    candidateHash: entry.hash,
    availableBefore,
    outcomes,
    runs: learningDb.prepare("SELECT * FROM learning_runs").all(),
    verdicts: learningDb.prepare("SELECT * FROM learning_verdicts").all(),
    productionQualified: false,
  });
  await learning.close();
}

try {
  if (operation === "acquire") {
    for (const fixture of cases("development"))
      await modelRun("acquire-" + fixture.id, "baseline", fixture);
    for (const kind of ["builder", "text-builder"] as const) {
      const generated = await modelRun(kind, kind);
      const snapshot = await snapshotPackage(path.join(generated.workspace, "candidate"), metadata);
      if (kind === "builder")
        assert(
          snapshot.files.has("helpers/fill_docx.py"),
          "Builder did not produce executable support",
        );
      else {
        assert.deepEqual([...snapshot.files.keys()], ["SKILL.md"]);
        assert(
          !/```/.test(snapshot.files.get("SKILL.md")!.toString()),
          "Text control contains runnable code blocks",
        );
      }
      await storePackage(kind === "builder" ? "executable" : "text", snapshot);
    }
  } else if (operation.startsWith("qualify-") || operation.startsWith("reuse-"))
    await workflow(
      operation.endsWith("recipient") ? "recipient" : "source",
      operation.startsWith("qualify-"),
    );
  else if (operation === "control") {
    const outcomes = [];
    for (const fixture of cases("evaluation")) {
      const folder = path.join(root, "control", fixture.id);
      await copyInputs(caseDir(fixture.id), path.join(folder, "inputs"));
      await fs.mkdir(path.join(folder, "output"));
      const execution = await dockerPython(
        protocol.image,
        [
          { source: path.join(suite, "deterministic_control.py"), target: "/control.py" },
          { source: path.join(folder, "inputs"), target: "/inputs" },
          { source: path.join(folder, "output"), target: "/output", write: true },
        ],
        [
          "/control.py",
          "--template",
          "/inputs/offer_letter_template.docx",
          "--data",
          "/inputs/employee_data.json",
          "--output",
          "/output/offer_letter_filled.docx",
        ],
        abort.signal,
      );
      const checked = await gradeOutput(
        protocol.image,
        suite,
        caseDir(fixture.id),
        path.join(folder, "output/offer_letter_filled.docx"),
        abort.signal,
      );
      outcomes.push({ caseId: fixture.id, execution, checked, handAuthored: true, learned: false });
      if (execution.exitCode !== 0 || checked.grade.status !== "pass")
        throw new Error("Qualified deterministic control failed");
    }
    await write(path.join(root, "control.json"), {
      outcomes,
      providerUsd: 0,
      humanDevelopmentCostMeasured: false,
    });
  } else if (operation === "compare") {
    const packages = new CollectiveSkillStore(db, path.join(root, "packages"));
    const text = await packages.read(
      (await read<{ packageHash: string }>(path.join(root, "text-package.json"))).packageHash,
    );
    for (let index = 0; index < cases("evaluation").length; index++) {
      if (index === 3) {
        const preflight = allRecords().filter(
          (r) =>
            r.id.startsWith("compare-") &&
            cases("evaluation")
              .slice(0, 3)
              .some((c) => c.id === r.caseId),
        );
        if (preflight.length === 6 && preflight.every((r) => r.grade?.status === "pass")) {
          await write(path.join(root, "comparison-stop.json"), {
            reason: "Perfect baseline and text preflight; no paid accuracy expansion",
            cases: 3,
            jobs: 6,
            freshHelperCases: 12,
          });
          break;
        }
      }
      const fixture = cases("evaluation")[index];
      for (const kind of index % 2
        ? (["text", "baseline"] as const)
        : (["baseline", "text"] as const))
        await modelRun(
          "compare-" + kind + "-" + fixture.id,
          kind,
          fixture,
          kind === "text" ? text : undefined,
        );
    }
  }
} finally {
  const report = {
    schemaVersion: 1,
    frozenHash: hash,
    at: new Date().toISOString(),
    operation,
    records: allRecords(),
    budget: {
      ...totals(),
      campaignCapUsd: cap.providerUsd,
      priorKnownUsd: frozen.inherited.knownUsd,
      priorReserveUsd: frozen.inherited.reserveUsd,
      remainingUsd: frozen.inherited.remainingUsd - totals().knownUsd - totals().heldUsd,
    },
    efficacyEstablished: false,
    productionActivated: false,
  };
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(exportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  if (lock) {
    await lock.close();
    await fs.unlink(path.join(root, "run.lock"));
  }
  db.close();
}
