/** Operator-only, bounded staged-candidate experiment. Never promotes production packages. */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { PackageSnapshot } from "../../src/agents/skills/collective/contracts.js";
import type { PeerEvidenceSummary } from "../../src/agents/skills/collective/evidence.js";
import type { ResearchBriefExecution } from "../../src/agents/skills/collective/research-brief.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import type { PracticalCase, PracticalGrade } from "./practical-learning.js";

const [operation, destination] = process.argv.slice(2);
if (
  !["prepare", "run", "report"].includes(operation) ||
  process.platform !== "linux" ||
  !destination ||
  path.dirname(destination) !== "/home/vicmg/.local/share/bitterbot-studies" ||
  !path.basename(destination).startsWith("practical-learning-")
)
  throw new Error("Use prepare|run|report with an isolated practical-learning study directory");
const root = path.resolve(destination),
  repository = fileURLToPath(new URL("../..", import.meta.url));
process.env.BITTERBOT_STATE_DIR = path.join(root, "state");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "state/bitterbot.json");
const [
  { learningHash, sha256, ReceiptSchema },
  { snapshotPackage, screenPackage },
  { compatibilityIssues },
  { signRecord, signRelease, verifyRecord },
  { generateKeyPair },
  { CollectiveSkillStore },
  { PeerEvidenceSchema, PeerEvidenceStore },
  { createResearchBriefHost },
  { createPackageProposalHost },
  { StudyLedger },
  { executionSources },
  { probeStudyImage },
  { PRACTICAL_ROOT, PRACTICAL_FAMILIES, CHECKER_FILES, practicalCases, practicalProtocol },
  { STATE_DIR },
  { SANDBOX_REGISTRY_PATH },
] = await Promise.all([
  import("../../src/agents/skills/collective/contracts.js"),
  import("../../src/agents/skills/collective/package.js"),
  import("../../src/agents/skills/collective/compatibility.js"),
  import("../../src/agents/skills/collective/signatures.js"),
  import("../../src/commerce/envelope.js"),
  import("../../src/agents/skills/collective/store.js"),
  import("../../src/agents/skills/collective/evidence.js"),
  import("../../src/agents/skills/collective/research-brief.js"),
  import("../../src/agents/skills/collective/proposal-host.js"),
  import("./study-ledger.js"),
  import("./deployment-driver.js"),
  import("./runtime-preflight.js"),
  import("./practical-learning.js"),
  import("../../src/config/paths.js"),
  import("../../src/agents/sandbox/constants.js"),
]);
if (
  path.resolve(STATE_DIR) !== path.join(root, "state") ||
  path.resolve(SANDBOX_REGISTRY_PATH) !== path.join(root, "state/sandbox/containers.json")
)
  throw new Error("Application state escaped study isolation");
const read = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const image = JSON.parse(await fs.readFile(path.join(PRACTICAL_ROOT, "runtime.json"), "utf8")) as {
  id: string;
  architecture: string;
};
const metadata = {
  name: "practical-work-procedure",
  description:
    "Complete local document, workbook and scheduling tasks using their stated contracts",
  requirements: {
    platforms: ["linux"],
    tools: { exec: "1", read: "1", write: "1", python3: "3" },
    capabilities: [],
    runtime: {},
  },
};
const ceiling = { providerUsd: 149, toolCalls: 112 * 21, wallMs: 112 * 480000 };
const arms = ["frozen", "local", "exchange", "pooled", "context"] as const;
type Arm = (typeof arms)[number];
type Origin = "a" | "b";
type Evidence = { id: string; evidence: PeerEvidenceSummary };
type Block = { replica: number; task: string; arms: Arm[] };
type Freeze = {
  schemaVersion: 1;
  createdAt: string;
  purpose: string;
  design: unknown;
  model: string;
  image: typeof image;
  sourceHashes: Record<string, string>;
  archiveHash: string;
  casesHash: string;
  configHash: string;
  seedHash: string;
  nodes: Record<string, string>;
  protocols: Record<string, { checkerHash: string; environmentHash: string }>;
  blocks: Block[];
  ceiling: typeof ceiling;
  taskQuote: { providerUsd: number; toolCalls: number; wallMs: number };
  proposalQuote: { providerUsd: number; toolCalls: number; wallMs: number };
  inherited: {
    authorizationUsd: number;
    knownUsd: number;
    unresolvedUsd: number;
    sourceSha256: string;
  };
  hash: string;
};
const agentId = (replica: number, origin: Origin) => `study-${replica}-${origin}`;
async function sources() {
  const result = await executionSources();
  for (const file of [
    ...CHECKER_FILES,
    "comparison-design.json",
    "runtime.json",
    "Dockerfile",
    "source-inventory.json",
    "runtime.py",
    "qualification_witnesses.py",
    "qualify_practical.py",
    "adversarial_qualification.py",
    "formula_compatibility.py",
    "lo_repetition_probe.py",
    "offer-semantics-probe.py",
    "court-validity-probe.py",
  ])
    result[`research/collective-learning/practical-learning/${file}`] = sha256(
      await fs.readFile(path.join(PRACTICAL_ROOT, file)),
    );
  return result;
}
async function verifySourceBytes() {
  const inventory = (await read(path.join(PRACTICAL_ROOT, "source-inventory.json"))) as {
    revision: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  if (inventory.revision !== "726e1f79b96b0cb3d729d0e55a1c847e0b5353ae")
    throw new Error("Unpinned source inventory");
  for (const file of inventory.files) {
    const bytes = await fs.readFile(path.join(PRACTICAL_ROOT, "upstream", file.path));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error("Upstream fixture drift");
  }
}
async function savePackage(folder: string, snapshot: PackageSnapshot) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of snapshot.files) {
    const target = path.join(folder, name);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, bytes, {
      flag: "wx",
      mode: snapshot.manifest.files.find((f) => f.path === name)?.executable ? 0o700 : 0o600,
    });
  }
}

if (operation === "prepare") {
  await verifySourceBytes();
  const cases = await practicalCases();
  const qualification = (await read(path.join(PRACTICAL_ROOT, "bridge-qualification.json"))) as {
    hash: string;
    casesHash: string;
    image: string;
    checkerSources: Record<string, string>;
    records: Array<{ id: string; grade: { status: string } }>;
  };
  const { hash: qualificationHash, ...qualificationBody } = qualification;
  if (
    learningHash(qualificationBody) !== qualificationHash ||
    qualification.casesHash !== learningHash(cases) ||
    qualification.image !== image.id ||
    qualification.records.length !== 23 ||
    qualification.records.some((r) => r.grade.status !== "pass")
  )
    throw new Error("Incomplete bridge qualification");
  for (const file of CHECKER_FILES)
    if (
      qualification.checkerSources[file] !==
      sha256(await fs.readFile(path.join(PRACTICAL_ROOT, file)))
    )
      throw new Error("Checker changed after qualification");
  const adversarial = (await read(
    path.join(PRACTICAL_ROOT, "witnesses/adversarial-qualification.json"),
  )) as { image: string; cases: number; matched: number; checkerSources: Record<string, string> };
  if (
    adversarial.image !== image.id ||
    adversarial.cases !== 60 ||
    adversarial.matched !== adversarial.cases
  )
    throw new Error("Checker challenges failed");
  for (const file of CHECKER_FILES)
    if (adversarial.checkerSources?.[file] !== qualification.checkerSources[file])
      throw new Error("Checker challenges are stale");
  const formulas = (await read(
    path.join(PRACTICAL_ROOT, "witnesses/formula-compatibility.json"),
  )) as {
    image: string;
    checkerSha256: string;
    functionProbes: Array<{ engine: string; function: string; matches: boolean }>;
  };
  const requiredFunctions = [
    "PERCENTILE",
    "QUARTILE",
    "_xlfn.QUARTILE.INC",
    "_xlfn.PERCENTILE.INC",
    "INDEX-MATCH",
    "_xlfn.XLOOKUP",
  ];
  if (
    formulas.image !== image.id ||
    formulas.checkerSha256 !== qualification.checkerSources["check_workbook.py"] ||
    requiredFunctions.some(
      (name) =>
        !formulas.functionProbes.some(
          (probe) => probe.engine === "libreoffice" && probe.function === name && probe.matches,
        ),
    )
  )
    throw new Error("Spreadsheet engine qualification is incomplete or stale");
  const design = await read(path.join(PRACTICAL_ROOT, "comparison-design.json"));
  const priorReport = path.join(
    repository,
    "reports/collective-learning/practical-learning-20261113-v2/report.json",
  );
  const previous = (await read(priorReport)) as {
    knownUsd: number;
    unknownReservedUsd: number;
    inherited: { authorizationUsd: number; knownUsd: number; unresolvedUsd: number };
  };
  const inherited = {
    authorizationUsd: previous.inherited.authorizationUsd,
    knownUsd: previous.inherited.knownUsd + previous.knownUsd,
    unresolvedUsd: previous.inherited.unresolvedUsd + previous.unknownReservedUsd,
    sourceSha256: sha256(await fs.readFile(priorReport)),
  };
  if (
    inherited.authorizationUsd -
      inherited.knownUsd -
      inherited.unresolvedUsd -
      ceiling.providerUsd <
    25
  )
    throw new Error("Insufficient authorized budget including retention margin");
  await probeStudyImage(image.id);
  await fs.mkdir(root, { mode: 0o700 });
  const priorRoot = "/home/vicmg/.local/share/bitterbot-studies/varied-headroom-20261113-v4";
  const config = (await read(path.join(priorRoot, "state/bitterbot.json"))) as BitterbotConfig;
  const template = config.agents!.list![0];
  const nodes: Record<string, string> = {};
  config.agents!.list = [];
  config.skills!.collective!.budget = ceiling;
  for (let replica = 0; replica < 2; replica++)
    for (const origin of ["a", "b"] as const) {
      const id = agentId(replica, origin),
        agentDir = path.join(root, "state/agents", id, "agent"),
        workspace = path.join(root, "state/workspaces", id);
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      config.agents!.list!.push({
        ...template,
        id,
        agentDir,
        workspace,
        sandbox: { ...template.sandbox, docker: { ...template.sandbox?.docker, image: image.id } },
      });
      for (const file of ["auth-profiles.json", "auth.json", "models.json"]) {
        const source = path.join(priorRoot, "state/agents/main/agent", file),
          stat = await fs.lstat(source).catch(() => null);
        if (!stat) continue;
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 4 * 1024 * 1024
        )
          throw new Error("Invalid credential source");
        await fs.writeFile(path.join(agentDir, file), await fs.readFile(source), {
          flag: "wx",
          mode: 0o600,
        });
      }
      const key = generateKeyPair();
      nodes[id] = `ed25519:${key.publicKeyHex}`;
      await fs.writeFile(
        path.join(root, "state", id + ".pem"),
        key.privateKey.export({ type: "pkcs8", format: "pem" }),
        { flag: "wx", mode: 0o600 },
      );
    }
  await write(path.join(root, "state/bitterbot.json"), config);
  await fs.mkdir(path.join(root, "seed-package"));
  await fs.writeFile(
    path.join(root, "seed-package/SKILL.md"),
    "---\nname: practical-work-procedure\ndescription: Complete local practical file tasks\n---\n\nRead the task instructions and supplied files. Follow their stated requirements and save all requested outputs. Use the locally available tools and libraries listed in runtime.txt. Inspect the finished files before ending the task. Do not install software, send messages or access the network.\n",
    { flag: "wx" },
  );
  await fs.writeFile(
    path.join(root, "seed-package/runtime.txt"),
    "Available tools: Python 3.11, openpyxl 3.1.5, python-docx 1.1.2, pypdf 5.1.0, pdfplumber 0.11.4, reportlab 4.2.5, LibreOffice Writer and Calc, ssconvert, pdftotext and pdftoppm.\n",
    { flag: "wx" },
  );
  const seed = await snapshotPackage(path.join(root, "seed-package"), metadata);
  screenPackage(seed);
  const protocols: Freeze["protocols"] = {};
  let taskQuote: Freeze["taskQuote"] | undefined;
  for (const family of PRACTICAL_FAMILIES) {
    const protocol = await practicalProtocol(
      cases.filter((c) => c.family === family),
      image.id,
    );
    const host = await createResearchBriefHost(
      config,
      agentId(0, "a"),
      nodes[agentId(0, "a")],
      "practical",
      image,
      { protocol },
    );
    if (compatibilityIssues(seed.manifest, host.environment).length)
      throw new Error("Seed incompatible");
    protocols[family] = {
      checkerHash: protocol.checkerHash,
      environmentHash: learningHash(host.environment),
    };
    taskQuote = host.quote(host.tasks[0]);
  }
  const proposalHost = await createPackageProposalHost(config, agentId(0, "a"));
  const blocks: Block[] = [];
  for (let replica = 0; replica < 2; replica++)
    for (const family of PRACTICAL_FAMILIES)
      for (const number of family === "court-form-filling" ? [1, 5] : [4, 5]) {
        const task = `${family}-${number}`;
        blocks.push({
          replica,
          task,
          arms: arms.toSorted((a, b) =>
            sha256(`practical-v1:${replica}:${task}:${a}`).localeCompare(
              sha256(`practical-v1:${replica}:${task}:${b}`),
            ),
          ),
        });
      }
  blocks.sort((a, b) => sha256(JSON.stringify(a)).localeCompare(sha256(JSON.stringify(b))));
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
    throw new Error("Source drift during freeze");
  const body: Omit<Freeze, "hash"> = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    purpose:
      "Four-condition plus context-control practical staged-candidate utility pilot; not powered efficacy or production qualification",
    design,
    model: config.skills!.collective!.validationModel!,
    image,
    sourceHashes,
    archiveHash: sha256(await fs.readFile(path.join(root, "execution-source.tar.gz"))),
    casesHash: learningHash(cases),
    configHash: sha256(await fs.readFile(path.join(root, "state/bitterbot.json"))),
    seedHash: seed.packageHash,
    nodes,
    protocols,
    blocks,
    ceiling,
    taskQuote: taskQuote!,
    proposalQuote: proposalHost.quote,
    inherited,
  };
  await write(path.join(root, "cases.json"), cases);
  await write(path.join(root, "qualification.json"), {
    bridge: qualification,
    adversarial,
    formulas,
  });
  await write(path.join(root, "frozen.json"), { ...body, hash: learningHash(body) });
  await write(path.join(root, "payload-review.json"), {
    frozenHash: learningHash(body),
    maximumCalls: 112,
    immediateCapUsd: ceiling.providerUsd,
    inherited,
    retentionAndMarginUsd:
      inherited.authorizationUsd -
      inherited.knownUsd -
      inherited.unresolvedUsd -
      ceiling.providerUsd,
    taskQuote,
    proposalQuote: proposalHost.quote,
    disclosure:
      "Pinned public benchmark task instructions, per-task input file bytes via local tool results, generic/generated skill packages, and compact checked acquisition summaries. No production conversations, credentials, reviewer notes, checkers or expected answers are supplied to learners.",
    scope:
      "Staged research utility only. No promotion, public publication, actual email sending or form filing.",
    design,
  });
  console.log(
    JSON.stringify({
      prepared: root,
      frozenHash: learningHash(body),
      paidCalls: 0,
      maximumCalls: 112,
      capUsd: ceiling.providerUsd,
    }),
  );
} else {
  const frozen = (await read(path.join(root, "frozen.json"))) as Freeze;
  const { hash, ...body } = frozen;
  if (learningHash(body) !== hash || frozen.image.id !== image.id)
    throw new Error("Frozen manifest drift");
  const db = new DatabaseSync(path.join(root, "study.sqlite")),
    ledger = new StudyLedger(db, frozen.ceiling);
  const rows = () =>
    db
      .prepare("SELECT body,state,cost,artifact,observation FROM study_charges ORDER BY rowid")
      .all() as Array<{
      body: string;
      state: string;
      cost: string | null;
      artifact: string | null;
      observation: string | null;
    }>;
  const report = async (status: string) => {
    const charges = rows(),
      knownUsd = charges.reduce((s, c) => s + (c.cost ? JSON.parse(c.cost).providerUsd : 0), 0),
      unknownReservedUsd = charges.reduce(
        (s, c) => s + (c.cost ? 0 : JSON.parse(c.body).quote.providerUsd),
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
      plannedAgentJobs: 112,
      providerRequestCountNote: "Each task or proposal job can make multiple model requests.",
      recorded: charges.length,
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
      retentionAvailable: false,
      runs,
    };
    await fs.writeFile(path.join(root, "report.tmp"), JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });
    await fs.rename(path.join(root, "report.tmp"), path.join(root, "report.json"));
    return { status, recorded: charges.length, knownUsd, unknownReservedUsd };
  };
  if (operation === "report")
    console.log(
      JSON.stringify(
        await report(((await read(path.join(root, "report.json"))) as { status: string }).status),
      ),
    );
  else {
    if (db.prepare("SELECT 1 FROM study_commands LIMIT 1").get())
      throw new Error("This runner never retries or resumes an uncertain study");
    const lock = await fs.open(path.join(root, "run.lock"), "wx", 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, hash, at: new Date().toISOString() }));
    const abort = new AbortController();
    process.on("SIGINT", () => abort.abort());
    process.on("SIGTERM", () => abort.abort());
    let status = "running";
    const nodeDbs: DatabaseSync[] = [];
    try {
      const cases = await practicalCases();
      if (learningHash(cases) !== frozen.casesHash) throw new Error("Case drift");
      const configBytes = await fs.readFile(path.join(root, "state/bitterbot.json"));
      if (sha256(configBytes) !== frozen.configHash) throw new Error("Config drift");
      const config = JSON.parse(configBytes.toString()) as BitterbotConfig;
      const seed = await snapshotPackage(path.join(root, "seed-package"), metadata);
      if (seed.packageHash !== frozen.seedHash) throw new Error("Seed drift");
      await verifySourceBytes();
      await probeStudyImage(image.id);
      await fs.mkdir(path.join(root, "artifacts"), { mode: 0o700 });
      await fs.mkdir(path.join(root, "evidence"), { mode: 0o700 });
      const assertFrozen = async () => {
        if (abort.signal.aborted) throw new Error("Study interrupted");
        if (learningHash(await sources()) !== learningHash(frozen.sourceHashes))
          throw new Error("Execution source drift");
      };
      const keys: Record<string, ReturnType<typeof generateKeyPair>> = {},
        stores: Record<string, InstanceType<typeof CollectiveSkillStore>> = {};
      for (const [id, node] of Object.entries(frozen.nodes)) {
        keys[id] = {
          privateKey: crypto.createPrivateKey(
            await fs.readFile(path.join(root, "state", id + ".pem")),
          ),
          publicKeyHex: node.slice(8),
        };
        const nodeDb = new DatabaseSync(path.join(root, "state", id + ".sqlite"));
        nodeDbs.push(nodeDb);
        stores[id] = new CollectiveSkillStore(nodeDb, path.join(root, "state", id + "-packages"));
        await stores[id].install(seed);
      }
      const finish = (
        id: string,
        phase: "acquisition" | "proposal" | "final",
        origin: Origin,
        artifact: object,
        cost: ResearchBriefExecution["result"]["cost"],
        tokens: number,
        success: boolean | null,
        family: string,
        environment: string,
      ) => {
        // One physical spending bucket. The experimental condition is retained in artifact.arm.
        ledger.finish(
          id,
          {
            taskId: id,
            family,
            node: origin,
            user: "public-benchmark-fixture",
            environment,
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
      const reserve = (
        id: string,
        phase: "acquisition" | "proposal" | "final",
        origin: Origin,
        quote: Freeze["taskQuote"],
      ) => ledger.reserve({ id, phase, node: origin, condition: "frozen", quote });
      const execution = async (
        replica: number,
        origin: Origin,
        item: PracticalCase,
        snapshot: PackageSnapshot,
        phase: "acquisition" | "final",
        label: string,
        arm: Arm,
        context = "",
        alreadyReserved = false,
      ): Promise<Evidence | undefined> => {
        await assertFrozen();
        const id = `r${replica}:${label}:${item.id}:${origin}`,
          agent = agentId(replica, origin);
        let recorded: ResearchBriefExecution | undefined, grade: PracticalGrade | undefined;
        const protocol = await practicalProtocol(
          cases.filter((c) => c.family === item.family),
          image.id,
          (g) => {
            grade = g;
          },
          PRACTICAL_ROOT,
          context,
        );
        if (protocol.checkerHash !== frozen.protocols[item.family].checkerHash)
          throw new Error("Checker drift");
        const task = { id: item.id, family: item.family, regression: false, input: item.input };
        const host = await createResearchBriefHost(
          config,
          agent,
          frozen.nodes[agent],
          "practical",
          image,
          {
            tasks: [task],
            protocol,
            onExecution: async (e) => {
              recorded = e;
            },
          },
        );
        const baselineEnvironment = context
          ? (
              await createResearchBriefHost(
                config,
                agent,
                frozen.nodes[agent],
                "practical",
                image,
                {
                  protocol: await practicalProtocol(
                    cases.filter((c) => c.family === item.family),
                    image.id,
                  ),
                },
              )
            ).environment
          : host.environment;
        if (learningHash(baselineEnvironment) !== frozen.protocols[item.family].environmentHash)
          throw new Error("Model, tool or sandbox environment drift");
        if (compatibilityIssues(snapshot.manifest, host.environment).length)
          throw new Error("Candidate incompatible");
        ledger.startCommand(id, {
          hash,
          replica,
          origin,
          task: item.id,
          packageHash: snapshot.packageHash,
          arm,
          phase,
        });
        if (!alreadyReserved) reserve(id, phase, origin, host.quote(task));
        console.log(JSON.stringify({ starting: id, arm, packageHash: snapshot.packageHash }));
        let thrown = false;
        try {
          await host.execute(task, snapshot, abort.signal);
        } catch {
          thrown = true;
        }
        const completed = recorded as ResearchBriefExecution | undefined,
          outcome = completed?.result.outcome ?? "infrastructure",
          checked = ["pass", "task-failure"].includes(outcome);
        const folder = path.join(root, "artifacts", sha256(id).slice(0, 20));
        await fs.mkdir(folder);
        const artifacts = [];
        for (const file of completed?.artifacts ?? []) {
          await fs.writeFile(path.join(folder, file.name), file.bytes, { flag: "wx", mode: 0o600 });
          artifacts.push({ name: file.name, sha256: file.sha256, bytes: file.bytes.length });
        }
        const detail = {
          type: "execution",
          id,
          replica,
          origin,
          phase,
          arm,
          task: item.id,
          family: item.family,
          packageHash: snapshot.packageHash,
          runId: completed?.runId ?? null,
          outcome,
          grade: grade ?? null,
          accessedFiles: completed?.result.accessedFiles ?? [],
          verifiedSkillRead: completed?.result.accessedFiles.includes("SKILL.md") ?? false,
          artifacts,
          artifactDirectory: path.relative(root, folder),
          diagnostic: completed?.diagnostic ?? null,
          environment: host.environment,
          thrown,
        };
        await write(path.join(folder, "execution.json"), detail);
        finish(
          id,
          phase,
          origin,
          detail,
          completed?.result.cost ?? null,
          completed?.tokens ?? 0,
          checked ? outcome === "pass" : null,
          item.family,
          learningHash(host.environment),
        );
        console.log(
          JSON.stringify({
            completed: id,
            outcome,
            cost: completed?.result.cost ?? null,
            used: detail.verifiedSkillRead,
          }),
        );
        await report("running");
        if (!completed?.result.cost || !checked || thrown)
          throw new Error(
            "Unknown cost, infrastructure, interruption or invalid checker; no retry",
          );
        if (phase === "final") return;
        const receipt = ReceiptSchema.parse({
          id: completed.runId,
          packageHash: snapshot.packageHash,
          node: frozen.nodes[agent],
          runId: completed.runId,
          taskHash: learningHash(item.input),
          family: item.family,
          environment: host.environment,
          partition: "acquisition",
          outcome,
          accessedFiles: completed.result.accessedFiles,
          cost: completed.result.cost,
          occurredAt: Date.now(),
        });
        stores[agent].db
          .prepare("INSERT INTO collective_receipts VALUES (?,?,?)")
          .run(receipt.id, receipt.packageHash, JSON.stringify(receipt));
        const conditions: Record<string, string> = {
          task: item.id,
          family: item.family,
          used: detail.verifiedSkillRead ? "SKILL.md read verified" : "candidate use unverified",
          issues: (grade?.issues.join("; ") ?? "missing-or-invalid-output").slice(0, 200),
          task0: item.input.instruction.slice(0, 200),
          task1: item.input.instruction.slice(200, 400),
          basis: "Host-checked artifact outcome; no held-out inputs or reference answers supplied",
          observedFunctions: Array.isArray(grade?.details.formulaFunctions)
            ? grade.details.formulaFunctions
                .filter((name): name is string => typeof name === "string")
                .join(", ")
                .slice(0, 200)
            : "not applicable",
        };
        const summary = PeerEvidenceSchema.parse(
          signRecord(
            "bitterbot/skill-evidence/1",
            {
              protocol: "bitterbot/skill-evidence/1",
              packageHash: snapshot.packageHash,
              origin: frozen.nodes[agent],
              executionId: receipt.id,
              kind: label !== "seed" && origin === "b" ? "source-execution" : "recipient-execution",
              outcome,
              failure: outcome === "pass" ? "none" : "artifact-contract-failure",
              environment: host.environment,
              conditions,
              partition: "acquisition",
              cost: completed.result.cost,
              scope: { kind: "circle", circleId: `offline-practical-${replica}` },
              expiresAt: Date.now() + 7 * 86400000,
            },
            keys[agent],
          ),
        );
        if (!verifyRecord(summary.protocol, summary, summary.origin))
          throw new Error("Evidence signature failed");
        const evidence = { id: learningHash(summary), evidence: summary };
        await write(path.join(root, "evidence", evidence.id + ".json"), { receipt, ...evidence });
        return evidence;
      };
      const propose = async (
        replica: number,
        origin: Origin,
        label: string,
        parent: PackageSnapshot,
        evidence: Evidence[],
      ) => {
        await assertFrozen();
        const id = `r${replica}:proposal:${label}`,
          agent = agentId(replica, origin);
        if (
          evidence.some(
            (e) =>
              e.evidence.packageHash !== parent.packageHash ||
              e.id !== learningHash(e.evidence) ||
              !verifyRecord(e.evidence.protocol, e.evidence, e.evidence.origin),
          )
        )
          throw new Error("Proposal evidence not bound to parent");
        if (JSON.stringify(evidence).length > 16000)
          throw new Error("Evidence exceeds predeclared bound");
        const host = await createPackageProposalHost(config, agent);
        ledger.startCommand(id, {
          hash,
          parent: parent.packageHash,
          evidence: evidence.map((e) => e.id),
        });
        reserve(id, "proposal", origin, host.quote);
        await write(path.join(root, `r${replica}-${label}-proposal-input.json`), evidence);
        console.log(
          JSON.stringify({ starting: id, evidence: evidence.length, parent: parent.packageHash }),
        );
        const result = await host.propose({ parent, evidence }, abort.signal);
        finish(
          id,
          "proposal",
          origin,
          {
            type: "proposal",
            replica,
            arm: label,
            packageHash: result.snapshot.packageHash,
            parent: parent.packageHash,
            evidenceIds: evidence.map((e) => e.id),
          },
          result.cost,
          result.tokens ?? 0,
          null,
          "proposal",
          image.id,
        );
        await savePackage(path.join(root, `r${replica}-${label}-package`), result.snapshot);
        screenPackage(result.snapshot);
        await stores[agent].install(result.snapshot);
        await write(path.join(root, `r${replica}-${label}-candidate.json`), {
          status: "staged",
          packageHash: result.snapshot.packageHash,
          manifest: result.snapshot.manifest,
          parent: parent.packageHash,
          evidenceIds: evidence.map((e) => e.id),
          generatedAt: new Date().toISOString(),
        });
        console.log(
          JSON.stringify({
            completed: id,
            packageHash: result.snapshot.packageHash,
            changed: result.snapshot.packageHash !== parent.packageHash,
            cost: result.cost,
          }),
        );
        await report("running");
        return result.snapshot;
      };
      const states: Array<{ packages: Record<Arm, PackageSnapshot>; context: string }> = [];
      for (let replica = 0; replica < 2; replica++) {
        const seedEvidence: { a: Evidence[]; b: Evidence[] } = { a: [], b: [] };
        for (const origin of ["a", "b"] as const)
          for (const family of PRACTICAL_FAMILIES.slice(0, 3)) {
            const number = origin === "a" ? replica + 1 : 2 - replica,
              item = cases.find((c) => c.id === `${family}-${number}`)!;
            seedEvidence[origin].push(
              (await execution(replica, origin, item, seed, "acquisition", "seed", "frozen"))!,
            );
          }
        const local = await propose(replica, "a", "local", seed, seedEvidence.a),
          peer = await propose(replica, "b", "peer", seed, seedEvidence.b);
        const recipientStore = stores[agentId(replica, "a")],
          sourceStore = stores[agentId(replica, "b")];
        const release = signRelease(
          {
            protocol: "bitterbot/skill-release/1",
            publisher: frozen.nodes[agentId(replica, "b")],
            skillId: `practical-replica-${replica}`,
            version: 1,
            packageHash: peer.packageHash,
            requirementsSummary: peer.manifest.requirements,
            previousRelease: null,
            parents: peer.packageHash === seed.packageHash ? [] : [seed.packageHash],
            scope: { kind: "circle", circleId: `offline-practical-${replica}` },
            issuedAt: Date.now(),
          },
          keys[agentId(replica, "b")],
        );
        sourceStore.addRelease(release);
        await recipientStore.install(await sourceStore.read(peer.packageHash));
        recipientStore.addRelease(release);
        const transferred = await recipientStore.read(peer.packageHash);
        if (transferred.packageHash !== peer.packageHash)
          throw new Error("Package transfer changed bytes");
        await write(path.join(root, `r${replica}-transfer.json`), {
          release,
          transport: "Offline signed package transfer between isolated stores on one host",
          files: transferred.manifest.files,
        });
        const exact: { a: Evidence[]; b: Evidence[] } = { a: [], b: [] };
        for (const origin of ["a", "b"] as const)
          for (const family of PRACTICAL_FAMILIES.slice(0, 3)) {
            const number = origin === "a" ? replica + 1 : 2 - replica,
              item = cases.find((c) => c.id === `${family}-${number}`)!;
            exact[origin].push(
              (await execution(
                replica,
                origin,
                item,
                transferred,
                "acquisition",
                "peer-parent",
                "exchange",
              ))!,
            );
          }
        const evidenceStore = new PeerEvidenceStore(recipientStore);
        for (const item of [...exact.a, ...exact.b]) evidenceStore.import(item.evidence);
        const pooledEvidence = evidenceStore.select(release);
        if (
          pooledEvidence.length !== 6 ||
          new Set(pooledEvidence.map((e) => e.evidence.origin)).size !== 2
        )
          throw new Error("Incomplete independent-origin evidence");
        const exchange = await propose(replica, "a", "exchange", transferred, exact.a),
          pooled = await propose(replica, "a", "pooled", transferred, pooledEvidence);
        states.push({
          packages: { frozen: seed, local, exchange, pooled, context: seed },
          context: JSON.stringify(seedEvidence.a),
        });
        await write(path.join(root, `r${replica}-frozen-learned-state.json`), {
          frozenAt: new Date().toISOString(),
          packages: Object.fromEntries(
            Object.entries(states[replica].packages).map(([arm, p]) => [arm, p.packageHash]),
          ),
          contextEvidence: seedEvidence.a.map((e) => e.id),
          parent: transferred.packageHash,
        });
      }
      for (const block of frozen.blocks) {
        await assertFrozen();
        const item = cases.find((c) => c.id === block.task)!,
          ids = block.arms.map((arm) => `r${block.replica}:final-${arm}:${item.id}:a`);
        db.exec("BEGIN IMMEDIATE");
        try {
          // Ledger.reserve owns a transaction, so use a separate conservative group-cap check
          // before sequential reservations. This runner holds the only study lock.
          const current = rows();
          const committed = current.reduce(
            (sum, row) =>
              sum +
              (row.cost
                ? JSON.parse(row.cost).providerUsd
                : JSON.parse(row.body).quote.providerUsd),
            0,
          );
          if (committed + frozen.taskQuote.providerUsd * arms.length > frozen.ceiling.providerUsd)
            throw new Error("Insufficient budget for complete final block");
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        for (const id of ids) reserve(id, "final", "a", frozen.taskQuote);
        const startedIds = new Set<string>();
        try {
          for (const arm of block.arms) {
            const id = `r${block.replica}:final-${arm}:${item.id}:a`;
            startedIds.add(id);
            await execution(
              block.replica,
              "a",
              item,
              states[block.replica].packages[arm],
              "final",
              `final-${arm}`,
              arm,
              arm === "context" ? states[block.replica].context : "",
              true,
            );
          }
        } finally {
          for (const id of ids)
            if (!startedIds.has(id))
              finish(
                id,
                "final",
                "a",
                { type: "not-executed", reason: "block-stopped-before-dispatch" },
                { providerUsd: 0, toolCalls: 0, wallMs: 0 },
                0,
                null,
                item.family,
                image.id,
              );
        }
      }
      status = "completed";
    } catch (error) {
      status = abort.signal.aborted ? "interrupted" : "stopped-error";
      console.error(error instanceof Error ? error.message : "Study error");
      process.exitCode = 1;
    } finally {
      console.log(JSON.stringify(await report(status)));
      for (const nodeDb of nodeDbs) nodeDb.close();
      await lock.close();
      await fs.unlink(path.join(root, "run.lock"));
    }
  }
  db.close();
}
