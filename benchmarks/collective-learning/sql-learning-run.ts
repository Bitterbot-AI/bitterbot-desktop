import { execFile } from "node:child_process";
/** Operator-only mechanism pilot. One training origin; no sharing, activation or efficacy claim. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PackageSnapshot } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefExecution } from "../../src/agents/skills/collective/research-brief.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import type { SqlLearningGrade } from "./sql-learning.js";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [operation, destination, qualifiedSource] = process.argv.slice(2);
if (
  !["prepare", "run", "report"].includes(operation) ||
  process.platform !== "linux" ||
  !destination ||
  path.dirname(destination) !== "/home/vicmg/.local/share/bitterbot-studies" ||
  !path.basename(destination).startsWith("sql-learning-")
)
  throw new Error(
    "Usage: sql-learning-run.ts prepare|run|report /home/vicmg/.local/share/bitterbot-studies/sql-learning-...",
  );
const root = path.resolve(destination),
  data = path.join(root, "data");
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
// All application imports follow the isolated environment. Several application
// modules capture state/config paths at initialization, not at first execution.
const [
  { compatibilityIssues },
  { learningHash, sha256, ReceiptSchema },
  { PeerEvidenceSchema },
  { snapshotPackage, screenPackage },
  { signRecord },
  { generateKeyPair },
  { BirdFixtureSchema },
  { executionSources },
  { probeStudyImage },
  { SqlLearningFixtureSchema, SqlLearningCaseSchema, sqlLearningProtocol, checkSqlLearning },
  { StudyLedger },
  { STATE_DIR },
  { SANDBOX_REGISTRY_PATH },
] = await Promise.all([
  import("../../src/agents/skills/collective/compatibility.js"),
  import("../../src/agents/skills/collective/contracts.js"),
  import("../../src/agents/skills/collective/evidence.js"),
  import("../../src/agents/skills/collective/package.js"),
  import("../../src/agents/skills/collective/signatures.js"),
  import("../../src/commerce/envelope.js"),
  import("./bird-calibration.js"),
  import("./deployment-driver.js"),
  import("./runtime-preflight.js"),
  import("./sql-learning.js"),
  import("./study-ledger.js"),
  import("../../src/config/paths.js"),
  import("../../src/agents/sandbox/constants.js"),
]);
if (
  path.resolve(STATE_DIR) !== path.join(root, "state") ||
  path.resolve(SANDBOX_REGISTRY_PATH) !== path.join(root, "state/sandbox/containers.json")
)
  throw new Error("Study state paths were initialized outside the isolated directory");
const { createResearchBriefHost } =
  await import("../../src/agents/skills/collective/research-brief.js");
const { createPackageProposalHost } =
  await import("../../src/agents/skills/collective/proposal-host.js");
const read = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const image = {
  id: "sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535",
  architecture: "amd64",
};
const priorRoot = "/home/vicmg/.local/share/bitterbot-studies/bird-calibration-20261112-v1";
const priorReport = path.join(
  repository,
  "reports/collective-learning/bird-calibration-20261112-v1/summary.json",
);
// All charges use ONE ledger bucket. Arms are separate artifact fields, not separate spending caps.
const ceiling = { providerUsd: 45, toolCalls: 57 * 20, wallMs: 57 * 240000 };
const metadata = {
  name: "sql-research-procedure",
  description: "A procedure for answering read-only SQLite questions",
  requirements: {
    platforms: ["linux"],
    tools: { exec: "1", read: "1", write: "1", python3: "3" },
    capabilities: [],
    runtime: {},
  },
};
const sources = async () => {
  const hashes = await executionSources();
  for (const file of [
    "bird_sql.py",
    "sql_learning_fixture.py",
    "sql_learning_check.py",
    "test_sql_learning.py",
  ]) {
    const relative = `benchmarks/collective-learning/benchmark-audit/${file}`;
    hashes[relative] = sha256(await fs.readFile(path.join(repository, relative)));
  }
  return hashes;
};
type Slot = {
  id: string;
  task: string;
  arm: "seed" | "learned";
  phase: "acquisition" | "selection";
  diagnostic: boolean;
};
type Freeze = {
  schemaVersion: 1;
  createdAt: string;
  purpose: string;
  model: string;
  sourceHashes: Record<string, string>;
  archiveHash: string;
  casesHash: string;
  configHash: string;
  checkerHash: string;
  environmentHash: string;
  parentHash: string;
  node: string;
  schedule: Slot[];
  ceiling: typeof ceiling;
  inherited: {
    authorizationUsd: number;
    knownUsd: number;
    unresolvedUsd: number;
    sourceSha256: string;
  };
  hash: string;
};

if (operation === "prepare") {
  await fs.mkdir(root, { mode: 0o700 });
  await promisify(execFile)(
    "python3",
    [
      path.join(
        repository,
        "benchmarks/collective-learning/benchmark-audit/sql_learning_fixture.py",
      ),
      data,
    ],
    { timeout: 120000 },
  );
  const fixture = SqlLearningFixtureSchema.parse(await read(path.join(data, "fixture.json")));
  const bird = BirdFixtureSchema.parse(await read(path.join(priorRoot, "fixture.json")));
  const acquisition = bird.cases
    .filter((c) => ["bird-74", "bird-172"].includes(c.id))
    .map((c) => ({
      id: c.id,
      family: c.family,
      kind: "public-acquisition",
      input: c.input,
      referenceSql: c.referenceSql,
      snapshots: [
        {
          file: `${c.family}.sqlite`,
          sha256: c.databaseSha256,
          bytes: c.databaseBytes,
          digest: c.referenceDigest,
        },
      ],
    }));
  for (const c of acquisition) {
    const file = c.snapshots[0];
    await fs.copyFile(
      path.join("/home/vicmg/.local/share/bitterbot-studies/bird-source-20261112-v1", file.file),
      path.join(data, file.file),
      fs.constants.COPYFILE_EXCL,
    );
    if (sha256(await fs.readFile(path.join(data, file.file))) !== file.sha256)
      throw new Error("Acquisition database drift");
  }
  const cases = [...acquisition, ...fixture.cases];
  const protocol = await sqlLearningProtocol(cases, data, image.id);
  const qualification = [];
  await probeStudyImage(image.id);
  if (qualifiedSource) {
    if (
      path.dirname(qualifiedSource) !== path.dirname(root) ||
      !path.basename(qualifiedSource).startsWith("sql-learning-") ||
      qualifiedSource === root
    )
      throw new Error("Invalid qualification source");
    const prior = (await read(path.join(qualifiedSource, "frozen.json"))) as Freeze;
    const { hash: oldHash, ...oldBody } = prior;
    if (
      oldHash !== learningHash(oldBody) ||
      prior.checkerHash !== protocol.checkerHash ||
      prior.casesHash !== learningHash(cases)
    )
      throw new Error(
        "Qualification reuse requires identical cases, checker code, protocol and image",
      );
    const checks = (await read(
      path.join(qualifiedSource, "container-qualification.json"),
    )) as Array<{ id: string; result: SqlLearningGrade }>;
    if (checks.length !== cases.length || new Set(checks.map((c) => c.id)).size !== cases.length)
      throw new Error("Invalid cached qualification");
    for (const item of cases) {
      const result = checks.find((c) => c.id === item.id)?.result;
      if (
        !result ||
        result.status !== "pass" ||
        result.snapshots.length !== item.snapshots.length ||
        result.snapshots.some(
          (g, i) => g.status !== "pass" || g.referenceDigest !== item.snapshots[i].digest,
        )
      )
        throw new Error("Incomplete cached qualification");
      for (const snapshot of item.snapshots)
        if (sha256(await fs.readFile(path.join(data, snapshot.file))) !== snapshot.sha256)
          throw new Error("Cached input bytes changed");
      qualification.push({ id: item.id, result });
    }
    await write(path.join(root, "qualification-reuse.json"), {
      source: qualifiedSource,
      frozenHash: oldHash,
      qualificationSha256: sha256(
        await fs.readFile(path.join(qualifiedSource, "container-qualification.json")),
      ),
      basis:
        "Identical checker/code/image/cases and independently rehashed input bytes; only package requirement metadata and orchestration guard changed",
    });
  } else
    for (const item of cases) {
      const result = await checkSqlLearning(item, item.referenceSql, data, image.id);
      if (result.status !== "pass") throw new Error(`Container reference failed: ${item.id}`);
      qualification.push({ id: item.id, result });
      console.log(
        JSON.stringify({ checkerQualified: item.id, snapshots: result.snapshots.length }),
      );
    }
  const config = (await read(path.join(priorRoot, "state/bitterbot.json"))) as BitterbotConfig;
  const agentDir = path.join(root, "state/agents/main/agent"),
    workspace = path.join(root, "state/workspace");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  config.agents!.list = [{ ...config.agents!.list![0], agentDir, workspace }];
  config.skills!.collective!.budget = ceiling;
  for (const file of ["auth-profiles.json", "auth.json", "models.json"]) {
    const source = path.join(priorRoot, "state/agents/main/agent", file);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
      throw new Error("Invalid credential source");
    await fs.writeFile(path.join(agentDir, file), await fs.readFile(source), {
      flag: "wx",
      mode: 0o600,
    });
  }
  await write(path.join(root, "state/bitterbot.json"), config);
  const key = generateKeyPair(),
    node = `ed25519:${key.publicKeyHex}`;
  await fs.writeFile(
    path.join(root, "state/study-key.pem"),
    key.privateKey.export({ type: "pkcs8", format: "pem" }),
    { flag: "wx", mode: 0o600 },
  );
  await fs.mkdir(path.join(root, "seed-package"));
  await fs.writeFile(
    path.join(root, "seed-package/SKILL.md"),
    "---\nname: sql-research-procedure\ndescription: Answer a read-only SQLite research question\n---\n\nRead the task and the available database schema. Inspect the local database as needed. Write a read-only SQLite query answering the question, test it locally, and provide the required output files. Follow the task's stated output contract.\n",
    { flag: "wx" },
  );
  const parent = await snapshotPackage(path.join(root, "seed-package"), metadata);
  screenPackage(parent);
  const host = await createResearchBriefHost(config, "main", node, "development", image, {
    protocol,
  });
  if (compatibilityIssues(parent.manifest, host.environment).length)
    throw new Error("Incompatible seed package");
  const proposalHost = await createPackageProposalHost(config, "main");
  const schedule: Slot[] = [];
  for (let repeat = 0; repeat < 2; repeat++)
    for (const c of acquisition)
      schedule.push({
        id: `${c.id}:acquisition:${repeat}`,
        task: c.id,
        arm: "seed",
        phase: "acquisition",
        diagnostic: true,
      });
  for (const c of fixture.cases.toSorted((a, b) =>
    learningHash(`sql-learning-v1:${a.id}`).localeCompare(learningHash(`sql-learning-v1:${b.id}`)),
  )) {
    const order: Slot["arm"][] =
      parseInt(sha256(c.id).slice(0, 2), 16) % 2 ? ["seed", "learned"] : ["learned", "seed"];
    for (const arm of order)
      schedule.push({
        id: `${c.id}:${arm}`,
        task: c.id,
        arm,
        phase: "selection",
        diagnostic: false,
      });
  }
  for (let repeat = 0; repeat < 2; repeat++)
    for (const c of acquisition)
      schedule.push({
        id: `${c.id}:learned-retest:${repeat}`,
        task: c.id,
        arm: "learned",
        phase: "selection",
        diagnostic: true,
      });
  const prior = (await read(priorReport)) as {
    costs: {
      knownUsd: number;
      unknownReservedUsd: number;
      inherited: { authorizationUsd: number; knownUsd: number; unresolvedUsd: number };
    };
  };
  const inherited = {
    authorizationUsd: prior.costs.inherited.authorizationUsd,
    knownUsd: prior.costs.inherited.knownUsd + prior.costs.knownUsd,
    unresolvedUsd: prior.costs.inherited.unresolvedUsd + prior.costs.unknownReservedUsd,
    sourceSha256: sha256(await fs.readFile(priorReport)),
  };
  if (
    inherited.authorizationUsd - inherited.knownUsd - inherited.unresolvedUsd <
    ceiling.providerUsd
  )
    throw new Error("Insufficient existing authorization");
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
    schemaVersion: 1 as const,
    createdAt: new Date().toISOString(),
    purpose: "One-origin learned SQL procedure mechanism pilot; not collective-learning efficacy",
    model: config.skills!.collective!.validationModel!,
    sourceHashes,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    casesHash: learningHash(cases),
    configHash: sha256(await fs.readFile(path.join(root, "state/bitterbot.json"))),
    checkerHash: protocol.checkerHash,
    environmentHash: learningHash(host.environment),
    parentHash: parent.packageHash,
    node,
    schedule,
    ceiling,
    inherited,
  };
  await write(path.join(root, "cases.json"), cases);
  await write(path.join(root, "container-qualification.json"), qualification);
  await write(path.join(root, "frozen.json"), { ...body, hash: learningHash(body) });
  await write(path.join(root, "payload-review.json"), {
    frozenHash: learningHash(body),
    purpose: body.purpose,
    model: body.model,
    maximumCalls: 57,
    totalCapUsd: ceiling.providerUsd,
    taskQuote: host.quote(host.tasks[0]),
    proposalQuote: proposalHost.quote,
    oneSharedBudgetBucket: true,
    taskPrompt: protocol.prompt,
    startingPackage: parent.manifest,
    disclosure:
      "Public BIRD acquisition questions/schema/database rows; authored public-like SQL fixtures; seed/generated package; standard tool prompts/results. No private data or production memory.",
    proposalInputs:
      "Only signed summaries extracted from the four new acquisition executions: public question, submitted query and checked outcome. No evaluation inputs, answers, reviewer findings or hand-authored repair.",
    proposalRule:
      "One existing production proposal-host call if at least one seed acquisition fails; otherwise stop with no reproducible failure. No candidate editing or selection after seeing evaluation outcomes.",
    endpoint:
      "24 matched fresh-session pairs: query must pass visible and eight hidden snapshots. Equal tools/model/limits; order counterbalanced by fixed hash. Four training-question retests reported separately.",
    limitations: [
      "Six vocabulary domains share one authored relational mechanism",
      "One training replica and two acquisition task identities",
      "Development diagnostic, not a powered efficacy or four-condition study",
      "Seed package changes the original no-package baseline",
      "No 24-hour retention or human ratings",
      "No automatic activation; proposal remains staged",
    ],
    stops: [
      "Completed fixed schedule",
      "No reproduced acquisition failure",
      "Budget exhausted",
      "Unknown cost",
      "Infrastructure/checker failure",
      "Source/config/fixture drift",
      "Interruption",
    ],
    automaticRetries: false,
    inherited,
  });
  console.log(
    JSON.stringify({
      prepared: root,
      frozenHash: learningHash(body),
      paidCalls: 0,
      tasks: schedule.length,
      capUsd: ceiling.providerUsd,
    }),
  );
} else {
  const frozen = (await read(path.join(root, "frozen.json"))) as Freeze;
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash) throw new Error("Frozen manifest drift");
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
    const knownUsd = charges.reduce(
      (sum, c) => sum + (c.cost ? JSON.parse(c.cost).providerUsd : 0),
      0,
    );
    const unknownReservedUsd = charges.reduce(
      (sum, c) => sum + (c.cost ? 0 : JSON.parse(c.body).quote.providerUsd),
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
      plannedTaskRuns: frozen.schedule.length,
      maximumProposalCalls: 1,
      recorded: runs.length,
      knownUsd,
      unknownReservedUsd,
      remainingAllocationUsd: frozen.ceiling.providerUsd - knownUsd - unknownReservedUsd,
      remainingOverallAuthorizationUsd:
        frozen.inherited.authorizationUsd -
        frozen.inherited.knownUsd -
        frozen.inherited.unresolvedUsd -
        knownUsd -
        unknownReservedUsd,
      inherited: frozen.inherited,
      efficacyEstablished: false,
      runs,
    };
    await fs.writeFile(path.join(root, "report.tmp"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(path.join(root, "report.tmp"), path.join(root, "report.json"));
    return { status, recorded: runs.length, knownUsd, unknownReservedUsd };
  };
  if (operation === "report") {
    const prior = (await read(path.join(root, "report.json"))) as { status: string };
    console.log(JSON.stringify(await report(prior.status)));
  } else {
    if (db.prepare("SELECT 1 FROM study_commands LIMIT 1").get())
      throw new Error("This runner never automatically resumes or retries a started study");
    const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, hash, at: new Date().toISOString() }));
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    let status = "running";
    try {
      const cases = ((await read(path.join(root, "cases.json"))) as unknown[]).map((c) =>
        SqlLearningCaseSchema.parse(c),
      );
      const configBytes = await fs.readFile(path.join(root, "state/bitterbot.json"));
      if (learningHash(cases) !== frozen.casesHash || sha256(configBytes) !== frozen.configHash)
        throw new Error("Input/config drift");
      const config = JSON.parse(configBytes.toString()) as BitterbotConfig;
      const parent = await snapshotPackage(path.join(root, "seed-package"), metadata);
      if (parent.packageHash !== frozen.parentHash) throw new Error("Parent package drift");
      const key = {
        privateKey: crypto.createPrivateKey(
          await fs.readFile(path.join(root, "state/study-key.pem")),
        ),
        publicKeyHex: frozen.node.slice(8),
      };
      let execution: ResearchBriefExecution | undefined, grade: SqlLearningGrade | undefined;
      const protocol = await sqlLearningProtocol(cases, data, image.id, (g) => {
        grade = g;
      });
      if (protocol.checkerHash !== frozen.checkerHash) throw new Error("Checker drift");
      await probeStudyImage(image.id);
      const host = await createResearchBriefHost(
        config,
        "main",
        frozen.node,
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
      if (compatibilityIssues(parent.manifest, host.environment).length)
        throw new Error("Incompatible seed package");
      const evidence: Array<{ id: string; evidence: ReturnType<typeof PeerEvidenceSchema.parse> }> =
        [];
      let candidate: PackageSnapshot | undefined;
      const finish = (
        id: string,
        phase: "acquisition" | "selection" | "proposal",
        artifact: object,
        cost: ResearchBriefExecution["result"]["cost"],
        tokens: number,
        success: boolean | null,
        family: string,
      ) => {
        ledger.finish(
          id,
          {
            taskId: id,
            family,
            node: "a",
            user: "development",
            environment: frozen.environmentHash,
            condition: "frozen",
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
        ledger.finishCommand(id, { completed: true });
      };
      for (const [index, slot] of frozen.schedule.entries()) {
        if (abort.signal.aborted) {
          status = "interrupted";
          break;
        }
        if (learningHash(await sources()) !== learningHash(frozen.sourceHashes))
          throw new Error("Execution source drift");
        if (index === 4) {
          if (!evidence.some((e) => e.evidence.outcome === "task-failure")) {
            status = "no-reproduced-acquisition-failure";
            break;
          }
          const proposalHost = await createPackageProposalHost(config, "main");
          const id = "proposal:0";
          ledger.startCommand(id, {
            frozenHash: hash,
            parent: parent.packageHash,
            evidence: evidence.map((e) => e.id),
          });
          ledger.reserve({
            id,
            condition: "frozen",
            node: "a",
            phase: "proposal",
            quote: proposalHost.quote,
          });
          await write(path.join(root, "proposal-input.json"), evidence);
          console.log(JSON.stringify({ starting: "proposal", evidence: evidence.length }));
          const result = await proposalHost.propose({ parent, evidence }, abort.signal);
          // Settle paid generation even if subsequent static screening fails.
          finish(
            id,
            "proposal",
            {
              type: "proposal",
              packageHash: result.snapshot.packageHash,
              parents: [parent.packageHash],
              evidenceIds: evidence.map((e) => e.id),
            },
            result.cost,
            result.tokens ?? 0,
            null,
            "proposal",
          );
          candidate = result.snapshot;
          await fs.mkdir(path.join(root, "learned-package"));
          for (const [name, bytes] of candidate.files) {
            const target = path.join(root, "learned-package", name);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, {
              flag: "wx",
              mode: candidate.manifest.files.find((f) => f.path === name)?.executable
                ? 0o700
                : 0o600,
            });
          }
          await write(path.join(root, "candidate.json"), {
            packageHash: candidate.packageHash,
            manifest: candidate.manifest,
            parents: [parent.packageHash],
            evidenceIds: evidence.map((e) => e.id),
            status: "staged",
            generatedAt: new Date().toISOString(),
          });
          screenPackage(candidate);
          if (compatibilityIssues(candidate.manifest, host.environment).length)
            throw new Error("Incompatible generated package remains staged");
          await report("running");
          console.log(
            JSON.stringify({
              proposalCompleted: true,
              changed: candidate.packageHash !== parent.packageHash,
              packageHash: candidate.packageHash,
              cost: result.cost,
            }),
          );
        }
        const item = cases.find((c) => c.id === slot.task)!;
        const task = { id: item.id, family: item.family, regression: false, input: item.input };
        const snapshot = slot.arm === "seed" ? parent : candidate!;
        if (!snapshot) throw new Error("Candidate missing");
        ledger.startCommand(slot.id, { hash, slot, packageHash: snapshot.packageHash });
        try {
          ledger.reserve({
            id: slot.id,
            condition: "frozen",
            node: "a",
            phase: slot.phase,
            quote: host.quote(task),
          });
        } catch {
          ledger.finishCommand(slot.id, { notExecuted: true, reason: "budget" });
          status = "budget-stopped";
          break;
        }
        execution = undefined;
        grade = undefined;
        console.log(JSON.stringify({ starting: index + 1, of: frozen.schedule.length, slot }));
        let thrown = false;
        try {
          await host.execute(task, snapshot, abort.signal);
        } catch {
          thrown = true;
        }
        const completed = execution as ResearchBriefExecution | undefined;
        const outcome = completed?.result.outcome ?? "infrastructure";
        const checked = ["pass", "task-failure"].includes(outcome);
        const artifact = {
          type: "execution",
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
        finish(
          slot.id,
          slot.phase,
          artifact,
          completed?.result.cost ?? null,
          completed?.tokens ?? 0,
          checked ? outcome === "pass" : null,
          item.family,
        );
        if (slot.phase === "acquisition" && completed && checked) {
          const receipt = ReceiptSchema.parse({
            id: completed.runId,
            packageHash: snapshot.packageHash,
            node: frozen.node,
            runId: completed.runId,
            taskHash: learningHash(task.input),
            family: item.family,
            environment: host.environment,
            partition: "acquisition",
            outcome,
            accessedFiles: completed.result.accessedFiles,
            cost: completed.result.cost,
            occurredAt: Date.now(),
          });
          const conditions: Record<string, string> = {
            task: item.id,
            evidenceBasis:
              "Host-checked result agreement on the public acquisition snapshot; no semantic equivalence claim",
          };
          for (const [label, value] of [
            ["question", item.input.question],
            ["query", (completed.brief as { sql?: unknown } | null)?.sql],
          ] as const) {
            if (typeof value === "string")
              for (let offset = 0; offset < Math.min(value.length, 1000); offset += 200)
                conditions[`${label}${offset / 200}`] = value.slice(offset, offset + 200);
          }
          const summary = PeerEvidenceSchema.parse(
            signRecord(
              "bitterbot/skill-evidence/1",
              {
                protocol: "bitterbot/skill-evidence/1",
                packageHash: snapshot.packageHash,
                origin: frozen.node,
                executionId: receipt.id,
                kind: "source-execution",
                outcome,
                failure: outcome === "pass" ? "none" : "query-result-disagreement",
                environment: host.environment,
                conditions,
                partition: "acquisition",
                cost: completed.result.cost,
                scope: { kind: "private" },
                expiresAt: Date.now() + 86400000,
              },
              key,
            ),
          );
          evidence.push({ id: learningHash(summary), evidence: summary });
          await write(path.join(root, `receipt-${completed.runId}.json`), receipt);
        }
        console.log(
          JSON.stringify({
            completed: index + 1,
            outcome,
            cost: completed?.result.cost ?? null,
            used: completed?.result.accessedFiles.includes("SKILL.md") ?? false,
          }),
        );
        await report("running");
        if (
          !completed?.result.cost ||
          thrown ||
          ["infrastructure", "checker-invalid", "interrupted"].includes(outcome)
        ) {
          status = "unknown-or-infrastructure-stop";
          break;
        }
      }
      if (status === "running") status = "completed";
    } catch (error) {
      status = "stopped-error";
      console.error(error instanceof Error ? error.message : "Study error");
      process.exitCode = 1;
    } finally {
      console.log(JSON.stringify(await report(status)));
      await lock.close();
      await fs.unlink(path.join(root, "run.lock"));
    }
  }
  db.close();
}
