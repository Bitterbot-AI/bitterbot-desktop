/** Operator-only development calibration. This does not train, qualify or activate a skill. */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSON5 from "json5";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import type { ResearchBriefExecution } from "../../src/agents/skills/collective/research-brief.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import { PrefixFixtureSchema, prefixProtocol, checkPrefixReport } from "./prefix-calibration.js";
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
    "Usage: prefix-calibration-run.ts prepare|run|report /absolute/new/study-directory (Linux)",
  );
const root = path.resolve(destination);
if (!root.startsWith("/home/vicmg/.local/share/bitterbot-studies/prefix-calibration-"))
  throw new Error("Calibration requires a dedicated, isolated study directory");
// Set all state paths before importing runtime modules with path/config caches.
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const { createResearchBriefHost } =
  await import("../../src/agents/skills/collective/research-brief.js");
const { snapshotPackage, screenPackage } =
  await import("../../src/agents/skills/collective/package.js");
const { executionSources } = await import("./deployment-driver.js");
const { probeStudyImage } = await import("./runtime-preflight.js");
const read = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8"));
const writeNew = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const requirements = {
  platforms: ["linux"],
  tools: { python3: "3" },
  runtime: {},
  capabilities: [],
};
const packageMetadata = {
  name: "prefix-cache-replay",
  description: "Pinned SkillsBench prefix-cache replay procedure; development calibration only",
  requirements,
};
const model = "anthropic/claude-opus-4-8";
const image = {
  id: "sha256:07d4824036af339fa1b6ef769cc99d9c10a141769538b52b3b597c84f7a7b535",
  architecture: "amd64",
};
const ceiling = { providerUsd: 30, toolCalls: 480, wallMs: 24 * 120000 };
type Slot = {
  id: string;
  task: string;
  replica: number;
  arm: "without-skill" | "supplied-expert-skill";
};
type Frozen = {
  schemaVersion: 1;
  purpose: string;
  createdAt: string;
  model: string;
  fixtureHash: string;
  packageHash: string;
  configHash: string;
  sourceHashes: Record<string, string>;
  archiveHash: string;
  environmentHash: string;
  ceiling: typeof ceiling;
  schedule: Slot[];
  hash: string;
};

if (operation === "prepare") {
  const sourceHashes = await executionSources();
  const inputs = path.join(repository, "research/collective-learning/prefix-calibration-inputs");
  const upstream = path.join(
    repository,
    "research/collective-learning/external/skillsbench-prefix",
  );
  const fixture = PrefixFixtureSchema.parse(await read(path.join(inputs, "fixture.json")));
  const protocol = prefixProtocol(fixture);
  const checkerProbes = fixture.cases.map((item) => {
    const wrongRows = structuredClone(item.expected);
    const hit = wrongRows.per_request.findIndex((r) => r.hit_tokens > 0);
    const miss = wrongRows.per_request.findIndex((r) => r.hit_tokens === 0);
    if (hit < 0 || miss < 0) throw new Error("Missing adversarial probe contrast");
    wrongRows.per_request[hit].hit_tokens--;
    wrongRows.per_request[miss].hit_tokens++;
    const mutants: unknown[] = [
      {},
      { ...item.expected, per_request: [] },
      wrongRows,
      { ...item.expected, total_hit_tokens: item.expected.total_hit_tokens + 1 },
      { ...item.expected, final_cache_blocks: item.input.config.cache_capacity_blocks + 1 },
      { ...item.expected, overall_hit_rate: NaN },
      { ...item.expected, per_request: item.expected.per_request.slice(1) },
      { ...item.expected, total_requests: true },
    ];
    const rejected = mutants.filter(
      (output) => !checkPrefixReport(item.input, item.expected, output),
    ).length;
    if (rejected !== mutants.length) throw new Error("Checker adversarial qualification failed");
    return {
      task: item.id,
      referenceAccepted: checkPrefixReport(item.input, item.expected, item.expected),
      incorrectOutputsRejected: rejected,
      probes: mutants.length,
    };
  });
  const probe = await probeStudyImage(image.id);
  const base = JSON5.parse(
    await fs.readFile("/home/vicmg/.bitterbot/bitterbot.json", "utf8"),
  ) as BitterbotConfig;
  await fs.mkdir(root, { mode: 0o700 }); // Fail if any prior study has this identity.
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
  await writeNew(path.join(root, "checker-qualification.json"), {
    paidModelCalls: 0,
    checkerProbes,
    fullRequestChecks: 8000,
    intention: "software qualification only",
  });
  await writeNew(
    path.join(root, "reference-qualification.json"),
    await read(path.join(inputs, "reference-qualification.json")),
  );
  const pkg = path.join(root, "package");
  await fs.mkdir(pkg, { mode: 0o700 });
  await fs.copyFile(
    path.join(upstream, "environment/skills/prefix-cache-replay/SKILL.md"),
    path.join(pkg, "SKILL.md"),
    fs.constants.COPYFILE_EXCL,
  );
  await fs.copyFile(
    path.join(
      repository,
      "benchmarks/collective-learning/benchmark-audit/vendor/skillsbench/LICENSE",
    ),
    path.join(pkg, "LICENSE"),
    fs.constants.COPYFILE_EXCL,
  );
  await writeNew(path.join(pkg, "attribution.json"), {
    source: "https://github.com/benchflow-ai/skillsbench",
    revision: fixture.upstreamRevision,
    sourcePath: "tasks/llm-prefix-cache-replay/environment/skills/prefix-cache-replay/SKILL.md",
    adaptation: "SKILL.md bytes preserved; host task prompt overrides original example file paths",
  });
  const snapshot = await snapshotPackage(pkg, packageMetadata);
  screenPackage(snapshot);
  await writeNew(path.join(root, "package-manifest.json"), snapshot.manifest);
  const host = await createResearchBriefHost(
    config,
    "main",
    "prefix-calibration",
    "development",
    image,
    { protocol },
  );
  const schedule: Slot[] = [];
  for (let replica = 0; replica < 3; replica++) {
    const ordered = fixture.cases.toSorted((a, b) =>
      learningHash(`${replica}:${a.id}`).localeCompare(learningHash(`${replica}:${b.id}`)),
    );
    for (const [i, task] of ordered.entries()) {
      const arms: Slot["arm"][] =
        (replica + i) % 2
          ? ["supplied-expert-skill", "without-skill"]
          : ["without-skill", "supplied-expert-skill"];
      for (const arm of arms)
        schedule.push({ id: `${task.id}:replica-${replica}:${arm}`, task: task.id, replica, arm });
    }
  }
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
  if (learningHash(sourceHashes) !== learningHash(await executionSources()))
    throw new Error("Source changed during freeze");
  const body = {
    schemaVersion: 1 as const,
    purpose:
      "Development calibration of headroom and supplied procedure use; not collective-learning efficacy",
    createdAt: new Date().toISOString(),
    model,
    fixtureHash: learningHash(fixture),
    packageHash: snapshot.packageHash,
    configHash: sha256(await fs.readFile(path.join(root, "state/bitterbot.json"))),
    sourceHashes,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    environmentHash: learningHash(host.environment),
    ceiling,
    schedule,
  };
  const frozen: Frozen = { ...body, hash: learningHash(body) };
  await writeNew(path.join(root, "frozen.json"), frozen);
  await writeNew(path.join(root, "payload-review.json"), {
    purpose: body.purpose,
    frozenHash: frozen.hash,
    model,
    probe,
    prompt: protocol.prompt,
    inputFile: "fixture.json (ONLY each case.input is disclosed)",
    packageManifest: snapshot.manifest,
    maximumTaskExecutions: 24,
    maximumProviderUsd: ceiling.providerUsd,
    accountingBucket:
      "frozen is a ledger bucket only; arms are supplied expert skill and without skill",
    independentTaskFamilies: 1,
    expertSkillSource: "upstream supplied, not learned locally",
    automaticRetries: false,
    unknownCostsRetainReservation: true,
    exclusions: [
      "hidden expected outputs",
      "checker code",
      "production memory",
      "private conversations",
      "credentials in prompts",
      "network tools",
      "public publishing",
    ],
    authorization: {
      originalTotalUsd: 250,
      earlierKnownUsd: 30.1507545,
      earlierUnknownReservedUsd: 14.4,
      allocatedHereUsd: 30,
      remainingUnallocatedUsd: 175.4492455,
      source:
        "User approved $250; subsequently requested stronger benchmark and confirmed proceeding",
      inheritedUnresolvedReservationsPreserved: true,
    },
    stopRules: [
      "Reservation would exceed cap",
      "Uncertain or unknown-cost execution",
      "Changed frozen inputs, code, model or configuration",
      "All 24 scheduled tasks complete",
    ],
    interpretations: [
      "Repeated runs and variants are not independent task families",
      "No selection, final evaluation, canary or retention conclusion",
      "Raw intention-to-treat results include unused-skill runs; verified use reported separately",
      "No success-driven early stopping or prompt changes during calibration",
    ],
  });
  console.log(
    JSON.stringify({
      prepared: root,
      frozenHash: frozen.hash,
      packageHash: snapshot.packageHash,
      tasks: schedule.length,
      quote: host.quote(host.tasks[0]),
      paidModelCalls: 0,
    }),
  );
} else {
  const frozen = (await read(path.join(root, "frozen.json"))) as Frozen;
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash) throw new Error("Frozen calibration was edited");
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
    const knownUsd = charges.reduce(
      (sum, row) => sum + (row.cost ? JSON.parse(row.cost).providerUsd : 0),
      0,
    );
    const unknownReservedUsd = charges.reduce(
      (sum, row) => sum + (!row.cost ? JSON.parse(row.body).quote.providerUsd : 0),
      0,
    );
    const runs = charges.map((row) => ({
      state: row.state,
      ...JSON.parse(row.artifact ?? "{}"),
      observation: row.observation ? JSON.parse(row.observation) : null,
    }));
    const arms = ["without-skill", "supplied-expert-skill"].map((arm) => {
      const items = runs.filter((r) => r.slot?.arm === arm);
      return {
        arm,
        planned: 12,
        recorded: items.length,
        checkedPasses: items.filter((r) => r.outcome === "pass").length,
        checkedFailures: items.filter((r) => r.outcome === "task-failure").length,
        unresolvedOutcomes: items.filter((r) => !["pass", "task-failure"].includes(r.outcome))
          .length,
        verifiedSkillReads: items.filter((r) => r.accessedFiles?.includes("SKILL.md")).length,
        knownUsd: items.reduce((s, r) => s + (r.observation?.cost?.providerUsd ?? 0), 0),
      };
    });
    const result = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      status,
      frozenHash: hash,
      purpose: frozen.purpose,
      independentTaskFamilies: 1,
      efficacyEstablished: false,
      arms,
      knownUsd,
      unknownReservedUsd,
      remainingAllocationUsd: frozen.ceiling.providerUsd - knownUsd - unknownReservedUsd,
      inheritedKnownUsd: 30.1507545,
      inheritedUnknownReservedUsd: 14.4,
      remainingOverallAuthorizationUsd: 250 - 30.1507545 - 14.4 - knownUsd - unknownReservedUsd,
      runs,
    };
    await fs.writeFile(path.join(root, "report.tmp"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(path.join(root, "report.tmp"), path.join(root, "report.json"));
    return { status, arms, knownUsd, unknownReservedUsd };
  };
  if (operation === "report") {
    const prior = (await read(path.join(root, "report.json")).catch(() => null)) as {
      status?: string;
    } | null;
    console.log(JSON.stringify(await report(prior?.status ?? "not-started")));
  } else {
    if (ledger.unresolved())
      throw new Error(
        "Unresolved calibration reservations require reconciliation; no automatic retry",
      );
    const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), hash }));
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    let status = "running";
    try {
      const fixture = PrefixFixtureSchema.parse(await read(path.join(root, "fixture.json")));
      const configBytes = await fs.readFile(path.join(root, "state/bitterbot.json"));
      const config = JSON.parse(configBytes.toString()) as BitterbotConfig;
      const snapshot = await snapshotPackage(path.join(root, "package"), packageMetadata);
      screenPackage(snapshot);
      if (
        learningHash(fixture) !== frozen.fixtureHash ||
        sha256(configBytes) !== frozen.configHash ||
        snapshot.packageHash !== frozen.packageHash
      )
        throw new Error("Calibration input/configuration/package drift");
      await probeStudyImage(image.id);
      const protocol = prefixProtocol(fixture);
      let execution: ResearchBriefExecution | undefined;
      const host = await createResearchBriefHost(
        config,
        "main",
        "prefix-calibration",
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
        throw new Error("Calibration environment drift");
      for (const [index, slot] of frozen.schedule.entries()) {
        if (abort.signal.aborted) {
          status = "interrupted";
          break;
        }
        if (learningHash(await executionSources()) !== learningHash(frozen.sourceHashes))
          throw new Error("Calibration execution source drift");
        const previous = ledger.startCommand(slot.id, { slot, hash });
        if (previous !== undefined) continue;
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
        } catch (error) {
          ledger.finishCommand(slot.id, { notExecuted: true, reason: String(error) });
          status = "budget-stopped";
          break;
        }
        execution = undefined;
        console.log(JSON.stringify({ starting: index + 1, of: frozen.schedule.length, slot }));
        let thrown = false;
        try {
          await host.execute(task, slot.arm === "without-skill" ? null : snapshot, abort.signal);
        } catch {
          thrown = true;
        }
        const completed = execution as ResearchBriefExecution | undefined;
        const outcome = completed?.result.outcome ?? "infrastructure";
        const checked = outcome === "pass" || outcome === "task-failure";
        const artifact = {
          slot,
          runId: completed?.runId ?? null,
          outcome,
          accessedFiles: completed?.result.accessedFiles ?? [],
          inputHash: learningHash(item.input),
          packageHash: slot.arm === "without-skill" ? null : snapshot.packageHash,
          diagnostic: completed?.diagnostic ?? null,
          output: completed?.brief ?? null,
          markdown: completed?.markdown ?? null,
          thrown,
        };
        ledger.finish(
          slot.id,
          {
            taskId: slot.id,
            family: task.family,
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
          JSON.stringify({
            completed: index + 1,
            outcome,
            verifiedSkillRead: artifact.accessedFiles.includes("SKILL.md"),
            cost: completed?.result.cost ?? null,
          }),
        );
        await report("running");
        if (!completed?.result.cost || thrown) {
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
