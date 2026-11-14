import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { learningHash, sha256 } from "../../src/agents/skills/collective/contracts.js";
import { snapshotPackage } from "../../src/agents/skills/collective/package.js";
import { RESEARCH_BRIEF_TASK_CONTRACT } from "../../src/agents/skills/collective/research-brief-contract.js";
import { resolvePackageSandboxImage } from "../../src/agents/skills/collective/sandbox-image.js";
import type { BitterbotConfig } from "../../src/config/config.js";
import {
  DeploymentSpecSchema,
  NODE_IDS,
  readJson,
  validateCorpus,
  verifyFrozen,
  writeNewJson,
  type DeploymentSpec,
  type FrozenDeployment,
} from "./deployment-contract.js";
import { assertRetentionReady } from "./node-contract.js";
import { probeStudyImage } from "./runtime-preflight.js";
import { StudyLedger } from "./study-ledger.js";
import type { NodeDescriptor } from "./study-node.js";
import { CONDITIONS, type StudyDriver, type PairedObservation } from "./study.js";
import { WorkerClient } from "./worker-client.js";

const repository = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export async function executionSources(): Promise<Record<string, string>> {
  const files: string[] = ["package.json", "pnpm-lock.yaml"];
  for (const name of await fs.readdir(path.join(repository, "src"), { recursive: true })) {
    if (/\.(ts|js|json)$/.test(name) && !/\.(test|spec)\.ts$/.test(name))
      files.push(`src/${name.replaceAll(path.sep, "/")}`);
  }
  for (const dir of ["benchmarks/collective-learning"])
    for (const name of await fs.readdir(path.join(repository, dir)))
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(`${dir}/${name}`);
  const hashes: Record<string, string> = {};
  const ordered = files.toSorted();
  for (let index = 0; index < ordered.length; index += 32) {
    for (const [file, hash] of await Promise.all(
      ordered
        .slice(index, index + 32)
        .map(async (file) => [file, sha256(await fs.readFile(path.join(repository, file)))]),
    ))
      hashes[file] = hash;
  }
  return hashes;
}
export async function prepareDeployment(
  input: unknown,
  destination: string,
  progress: (message: string) => void = () => {},
): Promise<FrozenDeployment> {
  const original = DeploymentSpecSchema.parse(input),
    root = path.resolve(destination);
  const sourceHashes = await executionSources();
  const corpus = validateCorpus(await readJson(original.corpusFile));
  if (original.purpose === "efficacy-study" && corpus.provenance !== "frozen-independent-corpus")
    throw new Error("Development fixtures cannot become an efficacy corpus");
  if (
    original.purpose === "efficacy-study" &&
    (original.conditions.length !== 4 || CONDITIONS.some((c) => !original.conditions.includes(c)))
  )
    throw new Error("Efficacy requires all four conditions");
  const base = JSON5.parse(await fs.readFile(original.baseConfig, "utf8")) as BitterbotConfig;
  const snapshot = await snapshotPackage(original.initialPackageDirectory, {
    name: "research-brief",
    description: "Frozen research brief procedure",
    requirements: { platforms: ["linux"], tools: { python3: "3" }, runtime: {}, capabilities: [] },
  });
  const image = await resolvePackageSandboxImage(
    { agents: { defaults: { sandbox: { docker: { image: original.sandboxImage } } } } },
    "main",
  );
  const runtimeProbe = await probeStudyImage(image.id);
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  await fs.mkdir(root, { mode: 0o700 }); // Never merge a new study into existing identities or results.
  const spec: DeploymentSpec = {
    ...original,
    corpusFile: path.join(root, "corpus.json"),
    initialPackageDirectory: path.join(root, "initial-package"),
    sandboxImage: image.id,
  };
  for (const [name, bytes] of snapshot.files) {
    const file = path.join(spec.initialPackageDirectory, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, bytes, {
      flag: "wx",
      mode: snapshot.manifest.files.find((f) => f.path === name)?.executable ? 0o700 : 0o600,
    });
  }
  await writeNewJson(spec.corpusFile, corpus);
  await writeNewJson(path.join(root, "deployment.json"), spec);
  const authFiles = ["auth-profiles.json", "auth.json", "models.json"];
  for (const condition of spec.conditions)
    for (const node of NODE_IDS) {
      const directory = path.join(root, "nodes", condition, node),
        agentDir = path.join(directory, "agents", "main", "agent"),
        workspace = path.join(directory, "workspace");
      await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      for (const filename of authFiles) {
        const source = path.join(original.authAgentDirectory, filename);
        const stat = await fs.lstat(source).catch(() => null);
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
            throw new Error("Unsafe credential configuration file");
          await fs.writeFile(path.join(agentDir, filename), await fs.readFile(source), {
            flag: "wx",
            mode: 0o600,
          });
        }
      }
      const config: BitterbotConfig = {
        models: base.models,
        auth: base.auth,
        tools: base.tools,
        plugins: { enabled: false },
        agents: {
          defaults: {
            model: { primary: spec.model, fallbacks: [] },
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
              workspace,
              agentDir,
              tools: base.agents?.list?.find((a) => a.id === "main")?.tools,
            },
          ],
        },
        skills: {
          collective: {
            enabled: true,
            publicMesh: false,
            synthesis: "off",
            validationModel: spec.model,
            budget: spec.groupCeiling,
          },
        },
      };
      await writeNewJson(path.join(directory, "bitterbot.json"), config);
    }
  const driver = await DeploymentStudyDriver.open(root, progress, false);
  try {
    const environments: FrozenDeployment["environments"] = {},
      configHashes: Record<string, string> = {},
      allNodes: NodeDescriptor[] = [];
    for (const condition of spec.conditions) {
      await driver.configure(condition, {
        localLearning: condition !== "frozen",
        exchange: ["exchange", "pooled"].includes(condition),
        synthesis: condition === "pooled",
        publicPublishing: false,
      });
      const descriptors = driver.descriptors!;
      if (
        descriptors[0].publisher === descriptors[1].publisher ||
        descriptors[0].pid === descriptors[1].pid
      )
        throw new Error("Pilot nodes are not independent processes and identities");
      if (descriptors.some((d) => d.packageHash !== snapshot.packageHash))
        throw new Error("Initial library mismatch");
      environments[condition] = { a: descriptors[0].environment, b: descriptors[1].environment };
      allNodes.push(...descriptors);
      for (const node of NODE_IDS) {
        const name = `nodes/${condition}/${node}/bitterbot.json`;
        configHashes[name] = sha256(await fs.readFile(path.join(root, name)));
      }
    }
    if (learningHash(sourceHashes) !== learningHash(await executionSources()))
      throw new Error("Execution source changed during preparation; prepare a new deployment");
    const body = {
      schemaVersion: 1 as const,
      spec,
      createdAt: Date.now(),
      corpusHash: learningHash(corpus),
      packageHash: snapshot.packageHash,
      sandboxImageId: image.id,
      environments,
      configHashes,
      sourceHashes,
    };
    const frozen = verifyFrozen({ ...body, hash: learningHash(body) });
    await writeNewJson(path.join(root, "frozen.json"), frozen);
    await writeNewJson(path.join(root, "readiness.json"), {
      readyAt: Date.now(),
      nodes: allNodes,
      privateTransport: "authenticated-encrypted-circle-over-loopback",
      conditions: spec.conditions,
      sourceData: corpus.provenance,
      paidCallsPerformed: 0,
      taskContract: RESEARCH_BRIEF_TASK_CONTRACT,
      runtimeProbe,
      efficacyClaim: false,
    });
    return frozen;
  } finally {
    await driver.close();
  }
}

export class DeploymentStudyDriver implements StudyDriver {
  clients: [WorkerClient, WorkerClient] | null = null;
  descriptors: [NodeDescriptor, NodeDescriptor] | null = null;
  condition: (typeof CONDITIONS)[number] | null = null;
  readonly ledger: StudyLedger;
  private constructor(
    readonly root: string,
    readonly spec: DeploymentSpec,
    readonly frozen: FrozenDeployment | null,
    readonly db: DatabaseSync,
    readonly progress: (message: string) => void,
  ) {
    this.ledger = new StudyLedger(db, spec.groupCeiling);
  }
  static async open(
    root: string,
    progress: (message: string) => void = () => {},
    verify = true,
  ): Promise<DeploymentStudyDriver> {
    root = path.resolve(root);
    const spec = DeploymentSpecSchema.parse(await readJson(path.join(root, "deployment.json")));
    const frozen = verify ? verifyFrozen(await readJson(path.join(root, "frozen.json"))) : null;
    if (frozen) {
      if (
        learningHash(spec) !== learningHash(frozen.spec) ||
        learningHash(await readJson(path.join(root, "corpus.json"))) !== frozen.corpusHash
      )
        throw new Error("Deployment input changed since freeze");
      if (learningHash(await executionSources()) !== learningHash(frozen.sourceHashes))
        throw new Error("Execution source changed since freeze; prepare a new pilot");
      for (const [name, hash] of Object.entries(frozen.configHashes))
        if (sha256(await fs.readFile(path.join(root, name))) !== hash)
          throw new Error("Node configuration changed since freeze");
    }
    const db = new DatabaseSync(path.join(root, "study.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    return new DeploymentStudyDriver(root, spec, frozen, db, progress);
  }
  async configure(
    condition: (typeof CONDITIONS)[number],
    options: {
      localLearning: boolean;
      exchange: boolean;
      synthesis: boolean;
      publicPublishing: false;
    },
  ): Promise<void> {
    const expected = {
      localLearning: condition !== "frozen",
      exchange: condition === "exchange" || condition === "pooled",
      synthesis: condition === "pooled",
      publicPublishing: false,
    };
    if (
      learningHash(options) !== learningHash(expected) ||
      !this.spec.conditions.includes(condition)
    )
      throw new Error("Condition configuration would change the frozen experiment");
    if (this.condition === condition && this.clients) return;
    await this.closeWorkers();
    this.condition = condition;
    const started: WorkerClient[] = [];
    const descriptors: NodeDescriptor[] = [];
    try {
      for (const node of NODE_IDS) {
        this.progress(`${condition}/${node}: starting isolated worker`);
        const client = new WorkerClient(
          path.join(this.root, "nodes", condition, node),
          path.join(this.root, "deployment.json"),
          condition,
          node,
          this.ledger,
          this.progress,
        );
        started.push(client);
        descriptors.push(await client.ready);
      }
    } catch (error) {
      await Promise.all(started.map((client) => client.close()));
      throw error;
    }
    this.clients = started as [WorkerClient, WorkerClient];
    this.descriptors = descriptors as [NodeDescriptor, NodeDescriptor];
    if (this.frozen)
      for (const descriptor of this.descriptors) {
        if (
          learningHash(descriptor.environment) !==
            learningHash(this.frozen.environments[condition][descriptor.node]) ||
          descriptor.packageHash !== this.frozen.packageHash
        )
          throw new Error("Execution environment or initial library drifted");
      }
    const owner = (await this.clients[0].call("peers", { peers: this.descriptors })) as {
      circleId: string;
      invite: string;
    };
    await this.clients[1].call("peers", { peers: this.descriptors, circleId: owner.circleId });
    // Join uses ordinary signed invitations; endpoints are refreshed on every process restart.
    await this.clients[1].call("join", { invite: owner.invite });
    for (const client of this.clients)
      await client.call("peers", { peers: this.descriptors, circleId: owner.circleId });
    for (const client of this.clients) await client.call("policy", { peers: this.descriptors });
  }
  private async command(
    node: number,
    method: string,
    input: Record<string, unknown>,
    suffix = "",
  ): Promise<unknown> {
    if (!this.clients || !this.condition) throw new Error("Configure two nodes first");
    const id = learningHash({
      deployment: this.frozen?.hash ?? this.spec.id,
      condition: this.condition,
      node: NODE_IDS[node],
      method,
      input,
      suffix,
    });
    const prior = this.db.prepare("SELECT state FROM study_commands WHERE id=?").get(id) as
      | { state: string }
      | undefined;
    if (prior?.state === "running") {
      const state = (await this.clients[node].call("status", { commandId: id })) as {
        command: { state: string; result: string } | null;
      };
      if (state.command?.state === "done") {
        const result = JSON.parse(state.command.result);
        this.ledger.finishCommand(id, result);
        return result;
      }
    }
    const priorResult = this.ledger.startCommand(id, { method, input });
    if (priorResult !== undefined) return priorResult;
    this.progress(`${this.condition}/${NODE_IDS[node]}: starting ${method}`);
    const result = await this.clients[node].call(method, input, id);
    this.ledger.finishCommand(id, result);
    return result;
  }
  async run(
    condition: (typeof CONDITIONS)[number],
    partition: "acquisition" | "selection" | "final",
    sources: readonly string[],
    signal: AbortSignal,
  ): Promise<PairedObservation[]> {
    if (condition !== this.condition) throw new Error("Study condition not configured");
    const corpus = validateCorpus(await readJson(path.join(this.root, "corpus.json")));
    const expected = [
      ...new Set(corpus.tasks.filter((t) => t.partition === partition).map((t) => t.corpus)),
    ].toSorted();
    if (learningHash([...sources].toSorted()) !== learningHash(expected))
      throw new Error("Scheduled corpus differs from frozen partition");
    signal.throwIfAborted();
    const stop = () => {
      for (const client of this.clients ?? []) client.child.kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (partition === "selection") {
        if (condition === "pooled")
          for (let n = 0; n < 2; n++) await this.command(n, "evidence", {});
        if (condition !== "frozen")
          for (let n = 0; n < 2; n++)
            await this.command(n, "learn", { pooled: condition === "pooled" });
        if (condition === "exchange" || condition === "pooled") {
          const announcements: string[][] = [];
          for (let n = 0; n < 2; n++)
            announcements.push((await this.command(n, "publish", {})) as string[]);
          for (let n = 0; n < 2; n++)
            await this.command(n, "receive", { ids: announcements[1 - n] });
        }
        for (let n = 0; n < 2; n++) await this.command(n, "freeze-learning", {});
      }
      for (let n = 0; n < 2; n++)
        await this.command(n, "tasks", {
          partition,
          ...(partition === "selection" ? { limit: 20 } : {}),
        });
      return this.ledger
        .observations()
        .filter(
          (r) =>
            r.condition === condition &&
            (r.phase === partition ||
              (partition === "selection" &&
                ["proposal", "validation", "transfer"].includes(r.phase))),
        );
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async smoke(signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const outcomes = [];
    const stop = () => {
      for (const client of this.clients ?? []) client.child.kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (let n = 0; n < 2; n++) {
        signal.throwIfAborted();
        outcomes.push(
          await this.command(n, "tasks", { partition: "acquisition", limit: 1 }, "readiness-smoke"),
        );
      }
      return {
        outcomes,
        observations: this.ledger.observations(),
        unknownCosts: this.ledger.unresolved(),
      };
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async retention(signal: AbortSignal): Promise<PairedObservation[]> {
    signal.throwIfAborted();
    const stop = () => {
      for (const client of this.clients ?? []) client.child.kill();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (let n = 0; n < 2; n++) {
        signal.throwIfAborted();
        // Reject premature requests before starting a durable execution command.
        const state = (await this.clients![n].call("status")) as {
          learningEndedAt: string | null;
          finalRanAt: string | null;
        };
        assertRetentionReady(state, this.spec.retentionHours);
        signal.throwIfAborted();
        await this.command(n, "tasks", { partition: "final", retention: true });
      }
      return this.ledger
        .observations()
        .filter((row) => row.condition === this.condition && row.retention);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async closeWorkers(): Promise<void> {
    const clients = this.clients;
    this.clients = null;
    if (clients) await Promise.all(clients.map((c) => c.close()));
  }
  async close(): Promise<void> {
    await this.closeWorkers();
    this.db.close();
  }
}
