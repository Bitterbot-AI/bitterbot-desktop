/** New contract/freeze; prior studies are immutable. Operator-owned development experiment. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PackageSnapshot,
  SkillPackageManifest,
} from "../../../src/agents/skills/collective/contracts.js";
import type { PeerEvidenceSummary } from "../../../src/agents/skills/collective/evidence.js";
import type { BitterbotConfig } from "../../../src/config/config.js";

const operation = process.argv[2];
export const repo = fileURLToPath(new URL("../../..", import.meta.url));
export const root = "/home/vicmg/.local/share/bitterbot-studies/executable-use-20261114-v3";
const prior = "/home/vicmg/.local/share/bitterbot-studies/executable-repair-20261113-v1";
export const suite = path.join(repo, "research/collective-learning/executable-use-v3");
const original = path.join(repo, "research/collective-learning/executable-learning");
export const exported = path.join(repo, "reports/collective-learning", path.basename(root));
assert.equal(process.platform, "linux");
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const [
  { learningHash, sha256 },
  { screenPackage, verifySnapshot },
  { CollectiveSkillStore },
  { createPackageProposalHost },
  { CompletedProposalError },
  { PeerEvidenceSchema },
  { signRecord, verifyRecord },
  { generateKeyPair },
  { StudyLedger },
  { executionSources },
  { dockerPython, gradeOutput, copyInputs, inputHashes },
] = await Promise.all([
  import("../../../src/agents/skills/collective/contracts.js"),
  import("../../../src/agents/skills/collective/package.js"),
  import("../../../src/agents/skills/collective/store.js"),
  import("../../../src/agents/skills/collective/proposal-host.js"),
  import("../../../src/agents/skills/collective/proposal-context.js"),
  import("../../../src/agents/skills/collective/evidence.js"),
  import("../../../src/agents/skills/collective/signatures.js"),
  import("../../../src/commerce/envelope.js"),
  import("../../../benchmarks/collective-learning/study-ledger.js"),
  import("../../../benchmarks/collective-learning/deployment-driver.js"),
  import("../../../benchmarks/collective-learning/executable-runtime.js"),
]);
export type Cost = { providerUsd: number; toolCalls: number; wallMs: number };
type PackageInfo = { packageHash: string; manifest: SkillPackageManifest };
export type Fixture = {
  id: string;
  partition: string;
  directory: string;
  missing?: string | null;
  files: Record<string, string>;
};
export const read = async <T>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(file, "utf8")) as T;
export const write = async (file: string, value: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
};
export const copyJson = async (name: string, value: unknown) => {
  await write(path.join(root, name), value);
  await write(path.join(exported, name), value);
};
const exec = promisify(execFile);
export const cap = { providerUsd: 15.6, toolCalls: 3000, wallMs: 36000000 };
const priorFreeze = await read<{ image: string; hash: string; checkerHash: string }>(
  path.join(prior, "frozen.json"),
);
const parentInfo = await read<PackageInfo>(path.join(prior, "candidate-package.json"));
const parentPath = path.join(prior, "packages/packages", parentInfo.packageHash, "content");
const interruptedRoot = "/home/vicmg/.local/share/bitterbot-studies/executable-use-20261114-v2";
const interrupted = await read<{ runId: string; candidate: PackageInfo }>(
  path.join(interruptedRoot, "proposal-execution.json"),
);
const proposalParentInfo = interrupted.candidate;
const proposalParentPath = path.join(interruptedRoot, "quarantine", interrupted.runId, "content");
export const contract = (
  await read<{
    publicDocxContractForNextRepair: import("../../../src/agents/skills/collective/proposal-context.js").PublicTaskContract;
  }>(path.join(repo, "research/collective-learning/next-wins-plan.json"))
).publicDocxContractForNextRepair;
export async function loadPackage(info: PackageInfo, directory: string): Promise<PackageSnapshot> {
  const files = new Map<string, Buffer>();
  for (const f of info.manifest.files) {
    const file = path.join(directory, f.path),
      stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    files.set(f.path, await fs.readFile(file));
  }
  const snapshot = { ...info, files, omitted: [] };
  verifySnapshot(snapshot);
  return snapshot;
}
export async function sources() {
  const result = await executionSources();
  for (const name of ["executable-completion-probe.py", "executable-completion-probe.ts"])
    result["research/collective-learning/" + name] = sha256(
      await fs.readFile(path.join(repo, "research/collective-learning", name)),
    );
  for (const dir of [suite, original])
    for (const name of await fs.readdir(dir, { recursive: true })) {
      // Old study cache files are neither executed nor mutated by this study.
      // Only source scripts and declared fixtures enter the freeze.
      if (name.includes("__pycache__") || name.endsWith(".pyc")) continue;
      const file = path.join(dir, name),
        stat = await fs.lstat(file);
      if (stat.isDirectory()) continue;
      assert(stat.isFile() && !stat.isSymbolicLink());
      result[path.relative(repo, file).split(path.sep).join("/")] = sha256(await fs.readFile(file));
    }
  return result;
}
const inventory = await read<Array<Omit<Fixture, "directory">>>(
  path.join(suite, "fixtures/inventory.json"),
);
const old = await read<{
  partitions: Array<{
    id: string;
    partition: string;
    files: Array<{ path: string; sha256: string }>;
  }>;
}>(path.join(original, "fixtures/inventory.json"));
export const fixtures: Fixture[] = [
  ...inventory.map((f) => ({ ...f, directory: path.join(suite, "fixtures", f.partition, f.id) })),
  ...old.partitions
    .filter((f) => f.partition === "evaluation")
    .map((f) => ({
      id: "regression-" + f.id,
      partition: "regression",
      directory: path.join(original, "fixtures/evaluation", f.id),
      files: Object.fromEntries(f.files.map((v) => [path.basename(v.path), v.sha256])),
    })),
];
const directCases = fixtures.filter((f) => f.partition !== "agent");

if (operation === "prepare") {
  for (const platform of ["windows", "linux"]) {
    const audit = await read<{ checks: number; allAgreed: boolean }>(
      path.join(exported, `checker-${platform}.json`),
    );
    assert.equal(audit.checks, 60);
    assert(audit.allAgreed);
  }
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(exported, { recursive: true });
  for (const fixture of fixtures)
    for (const [name, hash] of Object.entries(fixture.files))
      assert.equal(sha256(await fs.readFile(path.join(fixture.directory, name))), hash);
  await loadPackage(parentInfo, parentPath);
  await loadPackage(proposalParentInfo, proposalParentPath);
  const config = await read<BitterbotConfig>(path.join(prior, "state/bitterbot.json"));
  const template = config.agents!.list![0],
    sourceAgent = template.agentDir!;
  const agentDir = path.join(root, "state/agents/builder/agent"),
    workspace = path.join(root, "state/workspaces/builder");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  config.agents!.list = [{ ...template, agentDir, workspace }];
  config.skills!.collective!.budget = cap;
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
  const checkerHash = learningHash(
    Object.fromEntries(
      Object.entries(await sources()).filter(
        ([name]) =>
          name.includes("/executable-use-v3/oracle/") ||
          name.endsWith("/executable-use-v3/checker.py") ||
          name.endsWith("/executable-runtime.ts"),
      ),
    ),
  );
  const audit = await read<{
    packageHash: string;
    records: Array<{ case: string; outcome: string; errorType: string; message: string }>;
    execution: { invocation: string[]; exitCode: number };
    cost: Cost;
  }>(path.join(interruptedRoot, "completion-acquisition.json"));
  assert.equal(audit.packageHash, proposalParentInfo.packageHash);
  assert(audit.records.length === 2 && audit.records.every((r) => r.outcome === "failure"));
  const acquisitionProbeHash = sha256(
    await fs.readFile(
      path.join(repo, "research/collective-learning/executable-completion-probe.py"),
    ),
  );
  await write(path.join(root, "completion-acquisition.json"), audit);
  const priorAcquisitionExport = await read<unknown>(
    path.join(exported, "completion-acquisition.json"),
  ).catch(() => null);
  if (priorAcquisitionExport) assert.deepEqual(priorAcquisitionExport, audit);
  else await write(path.join(exported, "completion-acquisition.json"), audit);
  const key = generateKeyPair();
  const evidence = [audit].map((record) => {
    assert.equal(record.execution.exitCode, 0);
    const value = PeerEvidenceSchema.parse(
      signRecord(
        "bitterbot/skill-evidence/1",
        {
          protocol: "bitterbot/skill-evidence/1",
          packageHash: proposalParentInfo.packageHash,
          origin: "ed25519:" + key.publicKeyHex,
          executionId:
            record.execution.invocation[record.execution.invocation.indexOf("--name") + 1],
          kind: "source-execution",
          outcome: "task-failure",
          failure: "inconsistent-internal-return-shapes",
          environment: {
            model: "none:direct-python",
            tools: { docker: priorFreeze.image },
            runtime: { python: "3.11", acquisitionProbeHash },
            checkerHash: acquisitionProbeHash,
          },
          conditions: {
            conditional: record.records[0].errorType + ": " + record.records[0].message,
            paragraph: record.records[1].errorType + ": " + record.records[1].message,
            mechanism:
              "Callers unpack three values from _apply_conditionals and two from _process_paragraph. Error paths and ordinary empty/non-token paragraphs return inconsistent shapes.",
            expected:
              "Finish the existing repair with small consistent changes; preserve the public task specification and all existing functionality.",
            provenance:
              "One actually executed host acquisition batch against the exact quarantined package; no selection/evaluation cases or answers supplied.",
          },
          reproduction: {
            fixtureId: "return-shape-acquisition-v1",
            input: {
              python:
                "_apply_conditionals('{{IF_RELOCATION}}Moving benefit{{END_IF_RELOCATION}}', {}) then unpack three values; _process_paragraph(Document().add_paragraph(), {}, set()) then unpack two values.",
            },
          },
          partition: "acquisition",
          scope: { kind: "private" },
          cost: record.cost,
          expiresAt: Date.now() + 7 * 86400000,
        },
        key,
      ),
    );
    assert(verifyRecord(value.protocol, value, value.origin));
    return { id: learningHash(value), evidence: value };
  });
  await copyJson("model-payload.json", {
    parent: proposalParentInfo,
    contract,
    evidence,
    hiddenCheckers: true,
    hiddenFreshFixtures: true,
    model: config.skills!.collective!.validationModel,
  });
  const host = await createPackageProposalHost(config, "builder", {
    publicContract: contract,
    agentTimeoutMs: 300000,
  });
  const pinnedSources = await sources();
  await fs.writeFile(
    path.join(root, "source-files.txt"),
    Object.keys(pinnedSources).join("\n") + "\n",
    { flag: "wx" },
  );
  await exec(
    "tar",
    [
      "-czf",
      path.join(root, "execution-source.tar.gz"),
      "-C",
      repo,
      "-T",
      path.join(root, "source-files.txt"),
    ],
    { timeout: 120000 },
  );
  const body = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sources: pinnedSources,
    image: priorFreeze.image,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    configHash: learningHash(config),
    parentPackageHash: proposalParentInfo.packageHash,
    baselinePackageHash: parentInfo.packageHash,
    acquisitionProbeHash,
    contract,
    checkerHash,
    taskContractHash: host.taskContractHash,
    model: config.skills!.collective!.validationModel,
    quote: host.quote,
    preflightWallMs: host.preflightWallMs,
    cap,
    budget: {
      authorizedUsd: 250,
      priorKnownUsd: 115.51948275,
      priorReserveUsd: 28.8,
      availableUsd: 105.68051725,
    },
    fixtures: fixtures.map(({ directory: _d, ...f }) => f),
    payloadHash: sha256(await fs.readFile(path.join(root, "model-payload.json"))),
    design: {
      proposalAttempts: 1,
      authorization:
        "User authorized continued repair and performance comparison within the remaining budget on 2026-11-14. This separate focused completion finishes the preserved incomplete artifact; both earlier interrupted attempts and $14.40 in learning-related holds remain unchanged.",
      proposalTimeoutMs: 300000,
      diagnostics:
        "Host-only callback persists bounded diagnostic metadata and any partial package bytes into private unvalidated quarantine before workspace cleanup.",
      arms: ["parent", "control", "candidate"],
      directCases: directCases.length,
      invalidEndpoint:
        "Nonzero exit with a diagnostic containing the missing field. Missing executable, timeout or environment error is infrastructure, not successful rejection.",
      qualification:
        "All valid selection/evaluation, invalid rejection, and prior regression cases must pass before the ordinary-agent comparison.",
      ordinaryAgent:
        "Eight reserved, disjoint task instances; paired no-helper versus retained-helper, counterbalanced sequential order. Separate comparison source freeze and quote admission before paid dispatch.",
      stop: "Unknown costs, invalid checker or infrastructure stop dependent work. One repair attempt, no automatic retry. Stage including agent comparison must stay within $15.60 of new reservations using a serial durable ledger; the two prior holds totaling $14.40 remains within the aggregate $30 development stage.",
      claim:
        "Task-specific repair and possible efficiency pilot, not production activation, independent node transfer, collective efficacy, or population noninferiority.",
    },
  };
  await copyJson("frozen.json", { ...body, hash: learningHash(body) });
  console.log(
    JSON.stringify({
      prepared: true,
      freeze: learningHash(body),
      quote: host.quote,
      modelCalls: 0,
    }),
  );
  process.exit(0);
}

export const frozen = await read<{
  hash: string;
  sources: Record<string, string>;
  image: string;
  configHash: string;
  payloadHash: string;
  quote: Cost;
  taskContractHash: string;
  contract: typeof contract;
}>(path.join(root, "frozen.json"));
const { hash: freezeHash, ...body } = frozen;
assert.equal(learningHash(body), freezeHash);
assert.deepEqual(await sources(), frozen.sources, "Frozen implementation changed");
assert.equal(learningHash(contract), learningHash(frozen.contract));
assert.equal(sha256(await fs.readFile(path.join(root, "model-payload.json"))), frozen.payloadHash);
export const config = await read<BitterbotConfig>(path.join(root, "state/bitterbot.json"));
assert.equal(learningHash(config), frozen.configHash);
export const db = new DatabaseSync(path.join(root, "ledger.sqlite"));
export const ledger = new StudyLedger(db, cap);
export const packages = new CollectiveSkillStore(db, path.join(root, "packages"));
export const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());
export function budget() {
  const rows = db.prepare("SELECT state,body,cost FROM study_charges").all() as Array<{
    state: string;
    body: string;
    cost: string | null;
  }>;
  const knownUsd = rows.reduce(
    (n, r) => n + (r.cost ? (JSON.parse(r.cost) as Cost).providerUsd : 0),
    0,
  );
  const heldUsd = rows.reduce(
    (n, r) => n + (r.cost ? 0 : (JSON.parse(r.body) as { quote: Cost }).quote.providerUsd),
    0,
  );
  return {
    knownUsd,
    heldUsd,
    unresolved: rows.filter((r) => r.state !== "settled").length,
    stageRemainingUsd: 15.6 - knownUsd - heldUsd,
    cumulativeKnownUsd: 115.51948275 + knownUsd,
    priorReserveUsd: 28.8,
    remainingUsd: 105.68051725 - knownUsd - heldUsd,
  };
}
export function settle(
  id: string,
  cost: Cost | null,
  tokens: number,
  artifact: unknown,
  success: boolean | null = null,
  phase = "proposal",
) {
  ledger.finish(
    id,
    {
      taskId: id,
      family: "docx-placeholder",
      node: "a",
      user: "authored-study",
      environment: frozen.image,
      condition: "local",
      phase,
      success,
      checked: success !== null,
      criticalFailure: false,
      retention: false,
      freshSession: true,
      elapsedHours: 0,
      newUser: false,
      cost,
      tokens,
      latencyMs: cost?.wallMs ?? 0,
      humanUsefulness: null,
      humanRecommendation: null,
    },
    artifact,
  );
}
export async function cleanContainers() {
  const registry = await read<{ entries: Array<{ containerName: string }> }>(
    path.join(root, "state/sandbox/containers.json"),
  ).catch(() => ({ entries: [] }));
  for (const entry of registry.entries) {
    assert(/^bitterbot-sbx-/.test(entry.containerName));
    const inspected = await exec("docker", ["inspect", entry.containerName], {
      maxBuffer: 1024 * 1024,
    }).catch(() => null);
    if (!inspected) continue;
    const info = (
      JSON.parse(inspected.stdout) as Array<{
        Image: string;
        Config: { Labels: Record<string, string> };
        Mounts: Array<{ Source: string }>;
      }>
    )[0];
    assert.equal(info.Image, frozen.image);
    assert.equal(info.Config.Labels["bitterbot.sandbox"], "1");
    const mounts = info.Mounts;
    assert(
      mounts.some(
        (m) =>
          m.Source.startsWith(root + path.sep) ||
          m.Source.startsWith("/tmp/bitterbot-package-proposal-"),
      ),
    );
    await exec("docker", ["rm", "-f", entry.containerName]);
  }
}
async function runCase(arm: string, fixture: Fixture) {
  const runRoot = path.join(root, "runs", arm, fixture.id),
    recordFile = path.join(runRoot, "record.json");
  const existing = await read<Record<string, unknown>>(recordFile).catch(() => null);
  if (existing) return existing;
  await fs.mkdir(path.dirname(runRoot), { recursive: true });
  await fs.mkdir(runRoot);
  const info =
    arm === "parent"
      ? parentInfo
      : arm === "control"
        ? null
        : await read<PackageInfo>(path.join(root, "candidate-package.json"));
  const directory =
    arm === "parent"
      ? parentPath
      : arm === "control"
        ? suite
        : path.join(packages.directory(info!.packageHash), "content");
  if (info) await loadPackage(info, directory);
  await copyInputs(fixture.directory, path.join(runRoot, "inputs"));
  await fs.mkdir(path.join(runRoot, "output"));
  const before = await inputHashes(path.join(runRoot, "inputs"));
  const entry = arm === "control" ? "deterministic_control.py" : "helpers/fill_docx.py";
  const execution = await dockerPython(
    frozen.image,
    [
      {
        source: arm === "control" ? path.join(suite, entry) : directory,
        target: arm === "control" ? "/program.py" : "/skill",
      },
      { source: path.join(runRoot, "inputs"), target: "/inputs" },
      { source: path.join(runRoot, "output"), target: "/output", write: true },
    ],
    [
      arm === "control" ? "/program.py" : "/skill/" + entry,
      "--template",
      "/inputs/offer_letter_template.docx",
      "--data",
      "/inputs/employee_data.json",
      "--output",
      "/output/offer_letter_filled.docx",
    ],
    abort.signal,
  );
  assert.deepEqual(await inputHashes(path.join(runRoot, "inputs")), before);
  if (info) await loadPackage(info, directory);
  const output = path.join(runRoot, "output/offer_letter_filled.docx");
  assert(
    ![124, 125, 126, 127, 137, 143].includes(execution.exitCode),
    "Infrastructure or interruption, not task outcome",
  );
  const rejected =
    execution.exitCode !== 0 &&
    (execution.stderr + execution.stdout).includes(fixture.missing ?? "");
  const checked = fixture.missing
    ? {
        grade: {
          status: rejected ? "pass" : "task-failure",
          issues: rejected ? [] : ["missing-requirement-not-rejected"],
          details: { endpoint: "invalid-input-rejection", missing: fixture.missing },
        },
        wallMs: 0,
      }
    : await gradeOutput(frozen.image, suite, fixture.directory, output, abort.signal);
  assert.notEqual(checked.grade.status, "checker-invalid");
  if (execution.exitCode !== 0 && !fixture.missing) {
    checked.grade.status = "task-failure";
    checked.grade.issues.push("helper-nonzero-exit");
  }
  const record = {
    arm,
    caseId: fixture.id,
    partition: fixture.partition,
    packageHash: info?.packageHash ?? null,
    helperHash: sha256(await fs.readFile(path.join(directory, entry))),
    inputHashes: before,
    outputHash: await fs
      .readFile(output)
      .then(sha256)
      .catch(() => null),
    ...execution,
    grade: checked.grade,
    checkerWallMs: checked.wallMs,
  };
  await write(recordFile, record);
  console.log(JSON.stringify({ arm, caseId: fixture.id, status: record.grade.status }));
  return record;
}
if (operation === "library") {
  /* comparison driver owns its own lock and execution-source freeze */
} else {
  const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
  try {
    if (operation === "baseline" || operation === "validate") {
      const records = [];
      for (const arm of operation === "baseline" ? ["control", "parent"] : ["candidate"])
        for (const fixture of directCases) records.push(await runCase(arm, fixture));
      const pass = (r: Record<string, unknown>) =>
        (r.grade as { status: string }).status === "pass";
      const qualified = records.filter((r) => r.arm !== "parent").every(pass);
      await copyJson(operation + ".json", {
        freezeHash,
        records,
        qualified,
        budget: budget(),
        modelCalls: 0,
      });
      assert(qualified, "Control/candidate failed; dependent paid work held");
    } else if (operation === "propose") {
      const baseline = await read<{ qualified: boolean }>(path.join(root, "baseline.json"));
      assert(baseline.qualified);
      assert.equal(ledger.unresolved(), 0);
      assert(budget().stageRemainingUsd >= frozen.quote.providerUsd);
      const host = await createPackageProposalHost(config, "builder", {
        publicContract: contract,
        agentTimeoutMs: 300000,
        onExecution: async ({ candidate, ...event }) => {
          await copyJson("proposal-execution.json", {
            ...event,
            candidate: candidate
              ? {
                  packageHash: candidate.packageHash,
                  manifest: candidate.manifest,
                  qualification: "unvalidated",
                }
              : null,
          });
          if (candidate) {
            verifySnapshot(candidate);
            for (const [name, bytes] of candidate.files) {
              const target = path.join(root, "quarantine", event.runId, "content", name);
              await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
              await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
            }
          }
          console.log(
            JSON.stringify({
              proposalDiagnostic: event.outcome,
              toolCalls: event.toolCalls,
              accessedFiles: event.accessedFiles,
              cost: event.cost,
              quarantinedHash: candidate?.packageHash ?? null,
            }),
          );
        },
      });
      assert.deepEqual(host.quote, frozen.quote);
      assert.equal(host.taskContractHash, frozen.taskContractHash);
      assert.equal(ledger.startCommand("repair-1", { freezeHash }), undefined);
      ledger.reserve({
        id: "repair-1",
        condition: "local",
        node: "a",
        phase: "proposal",
        quote: host.quote,
      });
      const payload = await read<{
        evidence: Array<{ id: string; evidence: PeerEvidenceSummary }>;
      }>(path.join(root, "model-payload.json"));
      for (const item of payload.evidence) {
        assert.equal(learningHash(item.evidence), item.id);
        assert(verifyRecord(item.evidence.protocol, item.evidence, item.evidence.origin));
      }
      let result;
      try {
        result = await host.propose(
          {
            parent: await loadPackage(proposalParentInfo, proposalParentPath),
            evidence: payload.evidence,
          },
          abort.signal,
        );
      } catch (error) {
        const cost = error instanceof CompletedProposalError ? error.cost : null;
        settle("repair-1", cost, 0, { status: "proposal-failed", cost });
        await copyJson("proposal-failed.json", { budget: budget(), cost });
        await cleanContainers();
        throw error;
      }
      settle("repair-1", result.cost, result.tokens ?? 0, {
        packageHash: result.snapshot.packageHash,
      });
      screenPackage(result.snapshot);
      await packages.install(result.snapshot);
      await copyJson("candidate-package.json", {
        packageHash: result.snapshot.packageHash,
        manifest: result.snapshot.manifest,
      });
      for (const [name, bytes] of result.snapshot.files) {
        const target = path.join(exported, "package", name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes, { flag: "wx" });
      }
      await copyJson("proposal.json", {
        freezeHash,
        parentPackageHash: proposalParentInfo.packageHash,
        baselinePackageHash: parentInfo.packageHash,
        packageHash: result.snapshot.packageHash,
        taskContractHash: host.taskContractHash,
        cost: result.cost,
        tokens: result.tokens,
        preflightWallMs: host.preflightWallMs,
        budget: budget(),
        hostEditedCode: false,
      });
      ledger.finishCommand("repair-1", { packageHash: result.snapshot.packageHash });
      await cleanContainers();
      console.log(JSON.stringify({ proposed: result.snapshot.packageHash, budget: budget() }));
    } else throw new Error("Unknown operation");
  } finally {
    await lock.close();
    await fs.unlink(path.join(root, "run.lock"));
    db.close();
  }
}
