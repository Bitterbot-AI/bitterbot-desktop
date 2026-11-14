import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { learningHash, lineageId, sha256 } from "../agents/skills/collective/contracts.js";
import { PeerEvidenceStore } from "../agents/skills/collective/evidence.js";
import { snapshotPackage } from "../agents/skills/collective/package.js";
import { SkillPolicyService } from "../agents/skills/collective/policy.js";
import {
  checkResearchBrief,
  researchBriefTasks,
} from "../agents/skills/collective/research-brief.js";
import type { CollectiveRuntime } from "../agents/skills/collective/runtime.js";
import { signRelease } from "../agents/skills/collective/signatures.js";
import { CollectiveSkillStore } from "../agents/skills/collective/store.js";
import { PackageDistribution, receivePackage } from "../agents/skills/collective/transport.js";
import {
  PackageValidator,
  type PackageExecutionHost,
} from "../agents/skills/collective/validation.js";
import type { KeyPair } from "../commerce/envelope.js";
import { generateKeyPair } from "../commerce/envelope.js";
import { handleCircleMethod, resetCircleRateLimits } from "../gateway/a2a/circles.js";
import { handleMailboxMethod } from "../gateway/a2a/mailbox.js";
import { ensureMemoryIndexSchema } from "../memory/memory-schema.js";
import { runMigrations } from "../memory/migrations.js";
import type { BoxKeyPair } from "./box-crypto.js";
import { generateBoxKeyPair } from "./box-crypto.js";
import { CirclesService, type FetchLike } from "./service.js";
import { handleCirclePackage } from "./skill-packages.js";

// Workflow contract, NOT a model-quality benchmark. Real HTTP, signing, sealed
// mailboxes and separate disk databases; generation and human review are scripted.
// No fleet bootstrap, external mailbox, real identity, credentials, or LLM calls.
type Node = {
  db: DatabaseSync;
  dbPath: string;
  key: KeyPair;
  box: BoxKeyPair;
  server: http.Server;
  url: string;
  offline: boolean;
  prompts: string[];
  service: CirclesService;
  collective?: CollectiveRuntime;
};
const SOURCE =
  "Source R1 (2026-11-01): 8 of 10 pilot teams finished setup. Source R2 (2026-11-07): 3 of those 8 returned next week.";
const REVIEWED =
  "Keep the rollout in beta. R1 reports 8/10 setup completions; R2 reports only 3/8 returning teams. Setup is promising, retention is uncertain. Next: interview the five teams that did not return; Jordan owns follow-up by Friday.";

describe("shared brief across isolated HTTP nodes", () => {
  let directory: string;
  let relay: Node;
  let ana: Node;
  let bob: Node;
  const nodes: Node[] = [];
  const wire: Array<{ url: string; body: string; method: string; error?: string }> = [];

  function openDb(file: string) {
    const db = new DatabaseSync(file);
    // Separate on-disk stores, with the same WAL mode used by the runtime.
    // Avoid a filesystem sync for every schema statement on Windows/WSL mounts.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });
    runMigrations(db);
    return db;
  }

  const localFetch: FetchLike = async (url, init) => {
    const target = new URL(url);
    if (target.hostname !== "127.0.0.1" || !nodes.some((node) => node.url === target.origin))
      throw new Error("Trial refused a non-fixture destination");
    const body = init?.body ?? "";
    const record = {
      url,
      body,
      method: (JSON.parse(body) as { method: string }).method,
      error: undefined as string | undefined,
    };
    wire.push(record);
    try {
      const response = await fetch(url, init);
      if (!response.ok) record.error = `${response.status}: ${await response.clone().text()}`;
      return response;
    } catch (error) {
      record.error =
        error instanceof Error ? `${error.message}: ${String(error.cause)}` : String(error);
      throw error;
    }
  };

  function service(node: Node, name: string, mailbox?: string) {
    return new CirclesService({
      db: node.db,
      keyPair: node.key,
      boxKeys: node.box,
      practiceKeys: generateKeyPair(),
      topicBus: null,
      fetchImpl: localFetch,
      config: {
        circles: {
          enabled: true,
          displayName: name,
          a2aPublicUrl: node.url,
          dial: { allowPrivate: true },
          mailbox: mailbox ? { enabled: true, url: mailbox } : { enabled: false },
          meshTopic: { enabled: false },
          p2pDial: { enabled: false },
          practicePartner: { enabled: false },
          sandbox: { enabled: false },
        },
      },
      draftLlm: async (prompt) => {
        node.prompts.push(prompt);
        return "DRAFT_ONLY_MARKER: " + REVIEWED;
      },
    });
  }

  async function node(name: string, mailbox?: string): Promise<Node> {
    const dbPath = path.join(directory, `${name}.sqlite`);
    const value = {
      db: openDb(dbPath),
      dbPath,
      key: generateKeyPair(),
      box: generateBoxKeyPair(),
      offline: false,
      prompts: [],
    } as Omit<Node, "server" | "url" | "service">;
    const server = http.createServer(async (req, res) => {
      try {
        if (value.offline) {
          res.writeHead(503).end("offline fixture");
          return;
        }
        if (req.method !== "POST" || req.url !== "/a2a") {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 128_000) {
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
        const outcome = rpc.method.startsWith("mailbox/")
          ? handleMailboxMethod(rpc.method, rpc.params, value.db, Date.now())
          : rpc.method.startsWith("circle/skill.") && (value as Node).collective
            ? await handleCirclePackage(
                rpc.method,
                rpc.params,
                value.db,
                Date.now(),
                value.box,
                (value as Node).collective,
              )
            : handleCircleMethod(rpc.method, rpc.params, value.db, Date.now(), {
                boxKeys: value.box,
              });
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
          }),
        );
      } catch (error) {
        res.writeHead(500).end(`fixture handler failed: ${String(error)}`);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const complete = Object.assign(value, {
      server,
      url: `http://127.0.0.1:${address.port}`,
    }) as Node;
    complete.service = service(complete, name, mailbox);
    nodes.push(complete);
    complete.db
      .prepare(
        "INSERT INTO chunks (id,path,source,start_line,end_line,hash,model,text,embedding,updated_at) VALUES (?,?,'memory',1,1,'test','test',?,'[]',?)",
      )
      .run(
        `${name}-memory`,
        "private.md",
        `${name.toUpperCase()}_PRIVATE_MEMORY_CANARY`,
        Date.now(),
      );
    return complete;
  }

  beforeEach(async () => {
    resetCircleRateLimits();
    wire.length = 0;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "bb-circles-brief-"));
    relay = await node("relay");
    ana = await node("ana", relay.url);
    bob = await node("bob", relay.url);
  });
  afterEach(async () => {
    for (const current of nodes.splice(0)) {
      await new Promise<void>((resolve) => {
        current.server.close(() => resolve());
        current.server.closeAllConnections();
      });
      current.db.close();
    }
    const resolved = path.resolve(directory);
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith("bb-circles-brief-")
    )
      throw new Error("Unsafe fixture cleanup path");
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  async function connect() {
    const circleId = ana.service.createCircle({ name: "Pilot research", kind: "research" });
    const invite = ana.service.createInviteCode({ circleId });
    const joined = await bob.service.redeemInviteCode(invite.code);
    expect(
      joined.status,
      JSON.stringify(wire.map(({ method, error }) => ({ method, error }))),
    ).toBe("connected");
    return invite.circleId;
  }

  it("transfers a complete package, independently executes it, preserves a pin and rolls back an update", async () => {
    const circleId = await connect();
    const makeRuntime = (current: Node): CollectiveRuntime => {
      const store = new CollectiveSkillStore(
        current.db,
        path.join(directory, current.key.publicKeyHex, "packages"),
      );
      const policies = new SkillPolicyService(
        store,
        (id, peer) =>
          current.service.store.getCircle(id)?.status === "active" &&
          current.service.store.getMember(id, peer)?.status === "active",
      );
      const result = {
        store,
        policies,
        distribution: new PackageDistribution(store, policies),
        evidence: new PeerEvidenceStore(store),
        hosts: new Map(),
      };
      current.collective = result;
      return result;
    };
    const source = makeRuntime(ana),
      target = makeRuntime(bob);
    const snapshot = await snapshotPackage(
      path.resolve("test/fixtures/collective-learning/research-brief"),
      {
        name: "research-brief",
        description: "Source-backed research briefs",
        requirements: { platforms: [], tools: {}, runtime: {}, capabilities: [] },
      },
    );
    await source.store.install(snapshot);
    await source.store.screen(snapshot.packageHash);
    const release = signRelease(
      {
        protocol: "bitterbot/skill-release/1",
        publisher: ana.service.pubkey,
        skillId: "research-brief",
        version: 1,
        previousRelease: null,
        parents: [],
        packageHash: snapshot.packageHash,
        scope: { kind: "circle", circleId },
        issuedAt: Date.now(),
      },
      ana.key,
    );
    const policy = {
      id: "trusted-briefs",
      scope: release.scope,
      enabled: true,
      agents: ["main"],
      publishers: [release.publisher],
      skillIds: [release.skillId],
      operations: ["publish", "evaluate", "adopt"],
      categories: ["skill-package"],
      capabilities: [],
      budget: { providerUsd: 0, toolCalls: 1000, wallMs: 3600000 },
      expiresAt: Date.now() + 600000,
    };
    source.policies.set(policy);
    target.policies.set(policy);
    // Fixture source qualification; recipient competence must still be independently executed below.
    source.store.state(snapshot.packageHash, "stable", null, "source-fixture");
    const beforeMemory = bob.db.prepare("SELECT * FROM chunks ORDER BY id").all();
    const id = await source.distribution.publish(
      "main",
      release,
      ana.service.createSkillPackageTransport(circleId, release.publisher),
    );
    expect(target.store.release(id)?.packageHash).toBe(snapshot.packageHash);
    await receivePackage(
      target.store,
      release,
      bob.service.createSkillPackageTransport(circleId, release.publisher),
      () => {
        if (!target.policies.list()[0].enabled) throw new Error("grant revoked");
      },
      AbortSignal.timeout(20000),
    );
    await target.store.screen(snapshot.packageHash);
    let ordinal = 0;
    const host: PackageExecutionHost = {
      node: bob.service.pubkey,
      environment: {
        model: "fixture-node-executor",
        tools: { node: process.version },
        runtime: { platform: process.platform },
        checkerHash: sha256(checkResearchBrief.toString()),
      },
      tasks: researchBriefTasks("independent-recipient"),
      acquisitionTaskHashes: new Set(),
      quote: () => ({ providerUsd: 0, toolCalls: 4, wallMs: 5000 }),
      execute: async (task, pkg) => {
        const scratch = path.join(directory, `execution-${++ordinal}`);
        fs.mkdirSync(scratch);
        const started = Date.now(),
          accesses: string[] = [];
        if (!pkg)
          return {
            outcome: "task-failure",
            accessedFiles: [],
            cost: { providerUsd: 0, toolCalls: 0, wallMs: Date.now() - started },
          };
        for (const [name, bytes] of pkg.files) {
          const file = path.join(scratch, name);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes);
        }
        const instructions = fs.readFileSync(path.join(scratch, "SKILL.md"), "utf8");
        if (!instructions.includes("scripts/build_brief.cjs"))
          throw new Error("Fixture executor has no applicable procedure");
        accesses.push("SKILL.md", "scripts/build_brief.cjs", "templates/brief.md");
        fs.writeFileSync(path.join(scratch, "input.json"), JSON.stringify(task.input));
        await promisify(execFile)(
          process.execPath,
          [
            path.join(scratch, "scripts/build_brief.cjs"),
            path.join(scratch, "input.json"),
            path.join(scratch, "brief.json"),
            path.join(scratch, "brief.md"),
          ],
          { timeout: 5000 },
        );
        const output = JSON.parse(fs.readFileSync(path.join(scratch, "brief.json"), "utf8"));
        return {
          outcome: checkResearchBrief(task.input, output) ? "pass" : "task-failure",
          accessedFiles: accesses,
          cost: { providerUsd: 0, toolCalls: 4, wallMs: Date.now() - started },
        };
      },
    };
    const validator = new PackageValidator(target.store, host, policy.budget);
    expect((await validator.validate(release, null, AbortSignal.timeout(30000))).passed).toBe(true);
    target.policies.authorize("main", release, "adopt", "skill-package");
    target.store.activate("main", release, learningHash(host.environment));
    // Exercise real companion-file runs in deterministic canary buckets.
    for (let i = 0; i < 5 && target.store.get(snapshot.packageHash)?.state === "canary"; i++)
      await validator.runCanary("main", release, AbortSignal.timeout(30000));
    expect(target.store.get(snapshot.packageHash)?.state).toBe("stable");
    const old = target.store.active("main", lineageId(release))!;
    target.store.pin("main", lineageId(release), true);
    const changed = new Map(snapshot.files);
    changed.set(
      "scripts/build_brief.cjs",
      Buffer.from("throw new Error('deliberate regression');\n"),
    );
    const { packageHash } = await import("../agents/skills/collective/contracts.js");
    const manifest = {
      ...snapshot.manifest,
      files: snapshot.manifest.files.map((f) => ({
        ...f,
        size: changed.get(f.path)!.length,
        hash: sha256(changed.get(f.path)!),
      })),
    };
    const update = { ...snapshot, manifest, files: changed, packageHash: packageHash(manifest) };
    await target.store.install(update);
    target.store.state(
      update.packageHash,
      "locally-validated",
      null,
      learningHash(host.environment),
    );
    const next = signRelease(
      {
        ...release,
        version: 2,
        previousRelease: id,
        parents: [release.packageHash],
        packageHash: update.packageHash,
      },
      ana.key,
    );
    target.store.addRelease(next);
    expect(() => target.store.activate("main", next, learningHash(host.environment))).toThrow(
      "pinned",
    );
    target.store.pin("main", lineageId(release), false);
    target.store.activate("main", next, learningHash(host.environment));
    target.store.rollback(
      "main",
      lineageId(release),
      learningHash(host.environment),
      "fixture-confirmed-regression",
    );
    expect(target.store.active("main", lineageId(release))?.hash).toBe(old.hash);
    expect(
      (await target.store.read(old.hash)).files
        .get("scripts/build_brief.cjs")
        ?.equals(snapshot.files.get("scripts/build_brief.cjs")!),
    ).toBe(true);
    expect(bob.db.prepare("SELECT * FROM chunks ORDER BY id").all()).toEqual(beforeMemory);
    expect(
      wire
        .filter((w) => w.method.startsWith("circle/skill."))
        .every(
          (w) =>
            !w.body.includes("Source-backed research briefs") &&
            !w.body.includes("PRIVATE_MEMORY_CANARY"),
        ),
    ).toBe(true);
    source.policies.revoke(policy.id);
    await expect(
      source.distribution.serve(
        { releaseId: id, objectHash: snapshot.packageHash, offset: 0 },
        bob.service.pubkey,
        circleId,
      ),
    ).rejects.toThrow("Approval");
  }, 60000);
});
