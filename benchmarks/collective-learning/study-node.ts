import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  learningHash,
  type SkillRelease,
  type PackageSnapshot,
} from "../../src/agents/skills/collective/contracts.js";
import { PeerEvidenceStore } from "../../src/agents/skills/collective/evidence.js";
import { snapshotPackage } from "../../src/agents/skills/collective/package.js";
import { SkillPolicyService } from "../../src/agents/skills/collective/policy.js";
import {
  createResearchBriefHost,
  type ResearchBriefExecution,
} from "../../src/agents/skills/collective/research-brief.js";
import type { CollectiveRuntime } from "../../src/agents/skills/collective/runtime.js";
import { signRelease } from "../../src/agents/skills/collective/signatures.js";
import { CollectiveSkillStore } from "../../src/agents/skills/collective/store.js";
import { PackageDistribution } from "../../src/agents/skills/collective/transport.js";
import {
  type PackageExecutionHost,
  type ValidationTask,
  type TrialResult,
} from "../../src/agents/skills/collective/validation.js";
import { loadOrCreateBoxKeys, type BoxKeyPair } from "../../src/circles/box-crypto.js";
import { CirclesService } from "../../src/circles/service.js";
import { handleCirclePackage } from "../../src/circles/skill-packages.js";
import {
  generateKeyPair,
  keyPairFromPrivateKeyPem,
  type KeyPair,
} from "../../src/commerce/envelope.js";
import { handleCircleMethod } from "../../src/gateway/a2a/circles.js";
import { ensureMemoryIndexSchema } from "../../src/memory/memory-schema.js";
import { runMigrations } from "../../src/memory/migrations.js";
import { type StudyTask } from "./deployment-contract.js";
import type { NodeOptions, NodeDescriptor } from "./node-contract.js";
import { runTasks, learn, publish, receive, shareEvidence } from "./study-node-learning.js";
import type { PairedObservation } from "./study.js";

type Phase = PairedObservation["phase"];
export type { NodeDescriptor } from "./node-contract.js";
export class StudyNode {
  readonly db: DatabaseSync;
  readonly store: CollectiveSkillStore;
  readonly policies: SkillPolicyService;
  readonly runtime: CollectiveRuntime;
  readonly allowedPeers = new Set<string>();
  key!: KeyPair;
  box!: BoxKeyPair;
  service!: CirclesService;
  host!: PackageExecutionHost;
  initial!: PackageSnapshot;
  server!: http.Server;
  url = "";
  private charge: {
    id: string;
    task: StudyTask;
    phase: Phase;
    retention: boolean;
    started: number;
    report?: ResearchBriefExecution;
  } | null = null;
  command = "";
  private sequence = 0;
  phase: Phase = "acquisition";
  retention = false;
  constructor(readonly options: NodeOptions) {
    const filename = path.join(options.directory, "node.sqlite"),
      fresh = !existsSync(filename);
    this.db = new DatabaseSync(filename);
    // Empty schema bootstrapping contains no execution/evidence state. Checkpoint it
    // before exposing the node; every operational write then uses FULL durability.
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=${fresh ? "NORMAL" : "FULL"}; PRAGMA busy_timeout=5000`,
    );
    ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(this.db);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS study_node_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS study_node_commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL,result TEXT)",
    );
    this.store = new CollectiveSkillStore(this.db, path.join(options.directory, "collective"));
    this.policies = new SkillPolicyService(
      this.store,
      (circle, publisher) =>
        this.service?.store.getCircle(circle)?.status === "active" &&
        this.service.store.getMember(circle, this.publisher)?.status === "active" &&
        this.service.store.getMember(circle, publisher)?.status === "active",
    );
    this.runtime = {
      store: this.store,
      policies: this.policies,
      distribution: new PackageDistribution(this.store, this.policies),
      evidence: new PeerEvidenceStore(this.store),
      hosts: new Map(),
    };
    this.db.exec("PRAGMA synchronous=FULL");
    if (fresh) this.db.exec("PRAGMA wal_checkpoint(FULL)");
  }
  get publisher(): string {
    return `ed25519:${this.key.publicKeyHex}`;
  }
  meta(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM study_node_meta WHERE key=?").get(key) as
          | { value: string }
          | undefined
      )?.value ?? null
    );
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO study_node_meta VALUES (?,?)").run(key, value);
  }
  async start(): Promise<NodeDescriptor> {
    const keyFile = path.join(this.options.directory, "identity.pem");
    try {
      this.key = keyPairFromPrivateKeyPem(await fs.readFile(keyFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = generateKeyPair();
      await fs.writeFile(keyFile, this.key.privateKey.export({ type: "pkcs8", format: "pem" }), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const boxFile = path.join(this.options.directory, "box.json");
    this.box = loadOrCreateBoxKeys(boxFile);
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method !== "POST" || req.url !== "/a2a") {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128000) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: string;
          method: string;
          params: unknown;
        };
        if (
          rpc.method.startsWith("circle/skill.") &&
          (!["exchange", "pooled"].includes(this.options.condition) ||
            (rpc.method === "circle/skill.evidence" && this.options.condition !== "pooled"))
        )
          throw new Error("Study condition forbids this incoming learning channel");
        const outcome = rpc.method.startsWith("circle/skill.")
          ? await handleCirclePackage(
              rpc.method,
              rpc.params,
              this.db,
              Date.now(),
              this.box,
              this.runtime,
            )
          : handleCircleMethod(rpc.method, rpc.params, this.db, Date.now(), {
              boxKeys: this.box,
            });
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
          }),
        );
      } catch {
        res.writeHead(400).end("Invalid private study request");
      }
    });
    this.server.requestTimeout = 30000;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Missing study address");
    this.url = `http://127.0.0.1:${address.port}`;
    this.service = new CirclesService({
      db: this.db,
      keyPair: this.key,
      boxKeys: this.box,
      practiceKeys: this.key,
      topicBus: null,
      fetchImpl: async (url, init) => {
        if (!this.allowedPeers.has(new URL(url).origin))
          throw new Error("Study refused a destination outside its two nodes");
        return fetch(url, init);
      },
      config: {
        circles: {
          enabled: true,
          displayName: `Study ${this.options.node}`,
          a2aPublicUrl: this.url,
          dial: { allowPrivate: true },
          mailbox: { enabled: false },
          meshTopic: { enabled: false },
          p2pDial: { enabled: false },
          practicePartner: { enabled: false },
          sandbox: { enabled: false },
        },
      },
    });
    this.initial = await snapshotPackage(this.options.spec.initialPackageDirectory, {
      name: "research-brief",
      description: "Frozen research brief procedure",
      requirements: {
        platforms: ["linux"],
        tools: { python3: "3" },
        runtime: {},
        capabilities: [],
      },
    });
    await this.store.install(this.initial);
    if (this.store.get(this.initial.packageHash)?.state === "candidate")
      await this.store.screen(this.initial.packageHash);
    this.setMeta("initial", this.initial.packageHash);
    const host = await (this.options.hostFactory ?? createResearchBriefHost)(
      this.options.config,
      "main",
      this.publisher,
      this.options.spec.id,
      undefined,
      {
        tasks: this.nextPanel(false),
        selectionTasks: () => this.nextPanel(true),
        acquisitionTaskHashes: new Set(
          this.tasks("acquisition").map((t) => learningHash({ family: t.family, input: t.input })),
        ),
        onExecution: async (report) => {
          if (this.charge) this.charge.report = report;
        },
      },
    );
    this.host = {
      ...host,
      execute: async (task, snapshot, signal) =>
        this.executeAccounted(host, task, snapshot, signal),
    };
    this.runtime.hosts.set("main", this.host);
    return {
      node: this.options.node,
      publisher: this.publisher,
      url: this.url,
      environment: this.host.environment,
      packageHash: this.initial.packageHash,
      pid: process.pid,
    };
  }
  tasks(partition: StudyTask["partition"]): StudyTask[] {
    return this.options.corpus.tasks.filter(
      (t) => t.node === this.options.node && t.partition === partition,
    );
  }
  nextPanel(advance: boolean): ValidationTask[] {
    const panel = Number(this.meta("selection-panel") ?? "0");
    if (panel >= 19)
      throw new Error("Fresh qualification panels exhausted; the reporting panel stays held out");
    const tasks = this.tasks("selection").filter((t) => t.regression || t.selectionPanel === panel);
    if (tasks.filter((t) => !t.regression).length < 20)
      throw new Error("Frozen fresh selection panels exhausted");
    if (advance) this.setMeta("selection-panel", String(panel + 1));
    return tasks;
  }
  row(
    task: StudyTask,
    outcome: TrialResult,
    id: string,
    tokens: number,
    latencyMs: number,
  ): PairedObservation {
    const lastLearning = Number(this.meta("learning-ended-at") ?? Date.now());
    return {
      taskId: this.phase === "validation" ? `${task.id}:${id.slice(0, 12)}` : task.id,
      family: task.family,
      node: this.options.node,
      user: task.user,
      environment: task.environment,
      condition: this.options.condition,
      phase: this.phase,
      success:
        outcome.outcome === "pass" ? true : outcome.outcome === "task-failure" ? false : null,
      checked: ["pass", "task-failure"].includes(outcome.outcome),
      criticalFailure: false,
      retention: this.retention,
      freshSession: true,
      elapsedHours: this.retention ? (Date.now() - lastLearning) / 3600000 : 0,
      newUser: task.newUser,
      cost: outcome.cost,
      tokens,
      latencyMs,
      humanUsefulness: null,
      humanRecommendation: null,
    };
  }
  private async executeAccounted(
    host: PackageExecutionHost,
    task: ValidationTask,
    snapshot: PackageSnapshot | null,
    signal: AbortSignal,
  ): Promise<TrialResult> {
    const meta = this.options.corpus.tasks.find(
      (t) => t.id === task.id && t.node === this.options.node,
    );
    if (!meta || learningHash(task.input) !== learningHash(meta.input))
      throw new Error("Execution task is outside the frozen corpus");
    const id = learningHash({
      command: this.command,
      sequence: this.sequence++,
      task: task.id,
      hash: snapshot?.packageHash ?? null,
    });
    const active = {
      id,
      task: meta,
      phase: this.phase,
      retention: this.retention,
      started: Date.now(),
      report: undefined as ResearchBriefExecution | undefined,
    };
    await this.options.accounting.reserve({
      id,
      condition: this.options.condition,
      node: this.options.node,
      phase: this.phase,
      quote: host.quote(task),
    });
    this.charge = active;
    let result: TrialResult = { outcome: "infrastructure", accessedFiles: [], cost: null };
    try {
      result = await host.execute(task, snapshot, signal);
      return result;
    } finally {
      this.charge = null;
      const report = active.report;
      await this.options.accounting.finish(
        id,
        this.row(meta, result, id, report?.tokens ?? 0, Date.now() - active.started),
        {
          runId: report?.runId ?? null,
          taskHash: learningHash(task.input),
          packageHash: snapshot?.packageHash ?? null,
          checkerHash: this.host.environment.checkerHash,
          outcome: result.outcome,
          accessedFiles: result.accessedFiles,
          brief: report?.brief ?? null,
          markdown: report?.markdown ?? null,
          diagnostic: report?.diagnostic ?? null,
        },
      );
    }
  }
  async configurePeers(
    peers: NodeDescriptor[],
    circleId?: string,
  ): Promise<{ circleId: string; invite?: string }> {
    for (const peer of peers) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(peer.url))
        throw new Error("Only isolated loopback study peers are supported");
      this.allowedPeers.add(peer.url);
    }
    const circle =
      circleId ??
      this.meta("circle") ??
      this.service.createCircle({ name: `Study ${this.options.spec.id}`, kind: "research" });
    const existing = this.service.store.getCircle(circle);
    if (
      existing &&
      (existing.status !== "active" ||
        this.service.store.getMember(circle, this.publisher)?.status !== "active")
    )
      throw new Error("Study Circle membership was disabled; restart cannot restore it");
    this.setMeta("circle", circle);
    for (const peer of peers)
      if (this.service.store.getMember(circle, peer.publisher))
        this.service.store.updateMemberEndpoints(
          circle,
          peer.publisher,
          { a2aUrl: peer.url },
          Date.now(),
        );
    return {
      circleId: circle,
      ...(!circleId ? { invite: this.service.createInviteCode({ circleId: circle }).code } : {}),
    };
  }
  async join(invite: string): Promise<void> {
    const circle = this.meta("circle"),
      existing = circle && this.service.store.getCircle(circle);
    if (existing) {
      if (
        existing.status !== "active" ||
        this.service.store.getMember(circle!, this.publisher)?.status !== "active"
      )
        throw new Error("Study Circle membership was disabled; restart cannot restore it");
      return;
    }
    const result = await this.service.redeemInviteCode(invite);
    if (result.status !== "connected")
      throw new Error(`Private Circle join failed: ${result.status}`);
  }
  setupPolicy(peers: NodeDescriptor[]): void {
    const exchange = this.options.condition === "exchange" || this.options.condition === "pooled";
    if (!this.policies.list().some((policy) => policy.id === "study-grant")) {
      if (this.meta("policy-initialized"))
        throw new Error("Study grant was removed; restart cannot restore it");
      this.policies.set({
        id: "study-grant",
        scope: { kind: "circle", circleId: this.meta("circle")! },
        enabled: true,
        agents: ["main"],
        publishers: peers.map((p) => p.publisher),
        skillIds: ["research-brief"],
        operations: exchange ? ["publish", "evaluate", "adopt", "evidence"] : ["evidence"],
        categories: ["skill-package", "execution-summary"],
        capabilities: [],
        budget: this.options.spec.groupCeiling,
        expiresAt: Date.now() + 30 * 86400000,
      });
    }
    this.setMeta("policy-initialized", "true");
    if (!this.meta("base-release"))
      this.setMeta("base-release", this.release(this.initial.packageHash, []));
  }
  release(hash: string, parents: string[]): string {
    const prior = this.db
      .prepare(
        "SELECT id,body FROM collective_releases WHERE lineage=? ORDER BY version DESC LIMIT 1",
      )
      .get(`${this.publisher}/research-brief`) as { id: string; body: string } | undefined;
    const previous = prior ? (JSON.parse(prior.body) as SkillRelease) : null;
    if (previous?.packageHash === hash) return prior!.id;
    return this.store.addRelease(
      signRelease(
        {
          protocol: "bitterbot/skill-release/1",
          publisher: this.publisher,
          skillId: "research-brief",
          version: (previous?.version ?? 0) + 1,
          previousRelease: prior?.id ?? null,
          parents,
          packageHash: hash,
          requirementsSummary: this.store.get(hash)!.manifest.requirements,
          scope: { kind: "circle", circleId: this.meta("circle")! },
          issuedAt: Date.now(),
        },
        this.key,
      ),
    );
  }
  currentHash(): string {
    return this.meta("current") ?? this.initial.packageHash;
  }
  currentRelease(): SkillRelease {
    return this.store.release(this.meta("current-release") ?? this.meta("base-release")!)!;
  }
  async commandRun(
    id: string,
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const hash = learningHash({ method, input });
    const prior = this.db
      .prepare("SELECT hash,state,result FROM study_node_commands WHERE id=?")
      .get(id) as { hash: string; state: string; result: string | null } | undefined;
    if (prior) {
      if (prior.hash !== hash) throw new Error("Command collision");
      if (prior.state === "done") return JSON.parse(prior.result!);
      throw new Error("Interrupted node command requires reconciliation");
    }
    this.db.prepare("INSERT INTO study_node_commands VALUES (?,?,'running',NULL)").run(id, hash);
    this.command = id;
    this.sequence = 0;
    let result: unknown;
    if (method === "tasks")
      result = await runTasks(
        this,
        input.partition as StudyTask["partition"],
        signal,
        Boolean(input.retention),
        input.limit as number | undefined,
      );
    else if (method === "learn") result = await learn(this, signal, Boolean(input.pooled));
    else if (method === "publish") result = await publish(this);
    else if (method === "receive") result = await receive(this, input.ids as string[], signal);
    else if (method === "evidence") result = await shareEvidence(this);
    else if (method === "freeze-learning") {
      if (!this.meta("learning-ended-at")) this.setMeta("learning-ended-at", String(Date.now()));
      result = { endedAt: Number(this.meta("learning-ended-at")), packageHash: this.currentHash() };
    } else throw new Error("Unsupported study operation");
    this.db
      .prepare("UPDATE study_node_commands SET state='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id);
    return result;
  }
  async close(): Promise<void> {
    if (this.server)
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
    this.db.close();
  }
}
