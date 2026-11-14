import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import { learningHash, packageHash, sha256 } from "./contracts.js";
import { PeerEvidenceStore, proposeFromEvidence } from "./evidence.js";
import { snapshotPackage } from "./package.js";
import { SkillPolicyService } from "./policy.js";
import { CompletedProposalError } from "./proposal-context.js";
import { signRecord, signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";

const databases: DatabaseSync[] = [],
  directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((db) => db.close());
  await Promise.all(directories.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-evidence-"));
  directories.push(root);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new CollectiveSkillStore(db, root),
    evidence = new PeerEvidenceStore(store);
  const parent = await snapshotPackage(
    path.resolve("test/fixtures/collective-learning/research-brief"),
    {
      name: "research-brief",
      description: "Source-backed research briefs",
      requirements: { platforms: [], tools: {}, runtime: {}, capabilities: [] },
    },
  );
  await store.install(parent);
  const key = generateKeyPair();
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher: `ed25519:${key.publicKeyHex}`,
      skillId: "brief",
      version: 1,
      packageHash: parent.packageHash,
      previousRelease: null,
      parents: [],
      scope: { kind: "circle", circleId: "research" },
      issuedAt: Date.now(),
    },
    key,
  );
  store.addRelease(release);
  const env = {
    model: "fixture/model",
    tools: { sources: "1" },
    runtime: {},
    checkerHash: sha256("host-checker"),
  };
  const report = (origin = generateKeyPair(), executionId = "run-1", model = "fixture/model") =>
    signRecord(
      "bitterbot/skill-evidence/1",
      {
        protocol: "bitterbot/skill-evidence/1",
        packageHash: parent.packageHash,
        origin: `ed25519:${origin.publicKeyHex}`,
        executionId,
        kind: "recipient-execution",
        outcome: "task-failure",
        failure: "timezone-date-boundary",
        environment: { ...env, model },
        conditions: { timezone: model },
        partition: "acquisition",
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 5 },
        scope: release.scope,
        expiresAt: Date.now() + 86400000,
      },
      origin,
    );
  return { store, evidence, parent, release, key, env, report };
}
describe("peer evidence and bounded proposals", () => {
  it("settles rejected completed proposals while retaining genuinely unknown reservations", async () => {
    for (const completed of [true, false]) {
      const f = await fixture();
      f.evidence.import(f.report());
      f.evidence.import(f.report());
      const quote = { providerUsd: 2, toolCalls: 20, wallMs: 150000 };
      const actual = { providerUsd: 0.3, toolCalls: 4, wallMs: 1000 };
      const taskContractHash = learningHash("host contract");
      const host = {
        quote,
        taskContractHash,
        preflightWallMs: 37,
        propose: async () => {
          throw completed ? new CompletedProposalError(actual) : new Error("provider interrupted");
        },
      };
      await expect(
        proposeFromEvidence(f.store, f.release, f.evidence, host, quote, AbortSignal.timeout(5000)),
      ).rejects.toThrow();
      const charge = f.store.db.prepare("SELECT status,cost,scope FROM learning_runs").get() as {
        status: string;
        cost: string | null;
        scope: string;
      };
      expect(charge.status).toBe(completed ? "settled" : "unknown");
      expect(charge.cost ? JSON.parse(charge.cost) : null).toEqual(completed ? actual : null);
      expect(charge.scope).toBe(
        learningHash({
          tool: "skill-package",
          operation: "evidence-proposal",
          version: "1",
          contractHash: taskContractHash,
        }),
      );
      const proposal = f.store.db.prepare("SELECT state,body FROM collective_proposals").get() as {
        state: string;
        body: string;
      };
      expect(proposal.state).toBe("failed");
      expect(JSON.parse(proposal.body).taskContractHash).toBe(taskContractHash);
      expect(JSON.parse(proposal.body).preflightWallMs).toBe(37);
      expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM collective_packages").get()?.n).toBe(1);
    }
  });
  it("authenticates reporters without treating their claims as local receipts", async () => {
    const f = await fixture(),
      report = f.report();
    const id = f.evidence.import(report);
    expect(f.evidence.import(report)).toBe(id);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM collective_receipts").get()?.n).toBe(0);
    expect(() => f.evidence.import({ ...report, outcome: "pass" })).toThrow("Invalid");
    expect(() => f.evidence.import({ ...report, partition: "held-out" })).toThrow();
    const origin = generateKeyPair();
    f.evidence.import(f.report(origin));
    expect(() => f.evidence.import(f.report(origin, "run-1", "different-environment"))).toThrow(
      "Conflicting",
    );
  });
  it("bounds prolific origins, keeps contradictory environments, and isolates Circles", async () => {
    const f = await fixture(),
      prolific = generateKeyPair();
    for (let i = 0; i < 40; i++) f.evidence.import(f.report(prolific, `run-${i}`, "model-a"));
    f.evidence.import(f.report(generateKeyPair(), "independent", "model-b"));
    const selected = f.evidence.select(f.release);
    expect(
      selected.filter((s) => s.evidence.origin === `ed25519:${prolific.publicKeyHex}`).length,
    ).toBeLessThanOrEqual(4);
    expect(selected.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(16002);
    expect(new Set(selected.map((s) => s.evidence.environment.model))).toEqual(
      new Set(["model-a", "model-b"]),
    );
    expect(
      f.evidence.select({ ...f.release, scope: { kind: "circle", circleId: "another-circle" } }),
    ).toEqual([]);
  });
  it("stages one traceable proposal per lineage/day and carries disclosure provenance", async () => {
    const f = await fixture();
    f.store.recordOrigin(f.parent.packageHash, f.release.scope);
    f.evidence.import(f.report());
    const cost = { providerUsd: 0, toolCalls: 1, wallMs: 5 };
    const host = {
      quote: cost,
      propose: async () => {
        const files = new Map(f.parent.files);
        files.set(
          "SKILL.md",
          Buffer.concat([
            files.get("SKILL.md")!,
            Buffer.from("\nIf timestamps cross midnight, preserve the source's stated timezone.\n"),
          ]),
        );
        const manifest = {
          ...f.parent.manifest,
          files: f.parent.manifest.files.map((file) => ({
            ...file,
            size: files.get(file.path)!.length,
            hash: sha256(files.get(file.path)!),
          })),
        };
        return {
          snapshot: { ...f.parent, manifest, files, packageHash: packageHash(manifest) },
          cost,
        };
      },
    };
    await expect(
      proposeFromEvidence(f.store, f.release, f.evidence, host, cost, AbortSignal.timeout(5000)),
    ).rejects.toThrow("independent");
    f.evidence.import(f.report());
    const hash = await proposeFromEvidence(
      f.store,
      f.release,
      f.evidence,
      host,
      cost,
      AbortSignal.timeout(5000),
    );
    expect(f.store.get(hash)?.state).toBe("candidate");
    expect(() => f.store.assertDisclosure(hash, { kind: "public" })).toThrow("disclosure");
    const row = f.store.db.prepare("SELECT body FROM collective_proposals").get();
    expect(JSON.parse(String(row?.body)).evidence).toHaveLength(2);
    await expect(
      proposeFromEvidence(f.store, f.release, f.evidence, host, cost, AbortSignal.timeout(5000)),
    ).rejects.toThrow();
  });
  it("exports only recorded host outcomes, with separate evidence permission", async () => {
    const f = await fixture();
    const policies = new SkillPolicyService(f.store, () => true);
    const policy = {
      id: "grant",
      enabled: true,
      scope: f.release.scope,
      agents: ["main"],
      publishers: [f.release.publisher],
      skillIds: [f.release.skillId],
      operations: ["publish"],
      categories: ["skill-package"],
      capabilities: [],
      budget: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
      expiresAt: Date.now() + 10000,
    };
    policies.set(policy);
    expect(() =>
      f.evidence.export("main", f.release, "fabricated", policies, f.key, {
        failure: "",
        conditions: {},
      }),
    ).toThrow("Approval");
    policies.set({ ...policy, operations: ["evidence"], categories: ["execution-summary"] });
    expect(() =>
      f.evidence.export("main", f.release, "fabricated", policies, f.key, {
        failure: "",
        conditions: {},
      }),
    ).toThrow("host execution");
    const receipt = {
      id: "held-out",
      runId: "run",
      packageHash: f.parent.packageHash,
      node: f.release.publisher,
      taskHash: learningHash("secret-answer"),
      family: "hidden",
      environment: f.env,
      partition: "held-out",
      outcome: "pass",
      accessedFiles: ["SKILL.md"],
      cost: null,
      occurredAt: Date.now(),
    };
    f.store.db
      .prepare("INSERT INTO collective_receipts VALUES (?,?,?)")
      .run(receipt.id, receipt.packageHash, JSON.stringify(receipt));
    expect(() =>
      f.evidence.export("main", f.release, receipt.id, policies, f.key, {
        failure: "",
        conditions: {},
      }),
    ).toThrow("disclosure");
    const selection = {
      ...receipt,
      id: "selection",
      runId: "selection",
      partition: "selection",
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
    };
    f.store.db
      .prepare("INSERT INTO collective_receipts VALUES (?,?,?)")
      .run(selection.id, selection.packageHash, JSON.stringify(selection));
    const reproduction = { fixtureId: "permitted-fixture", input: { date: "2026-11-01" } };
    expect(() =>
      f.evidence.export(
        "main",
        f.release,
        selection.id,
        policies,
        f.key,
        { failure: "date", conditions: {} },
        reproduction,
      ),
    ).toThrow("Approval");
    policies.set({
      ...policy,
      operations: ["evidence"],
      categories: ["execution-summary", "minimal-reproduction"],
    });
    expect(
      f.evidence.export(
        "main",
        f.release,
        selection.id,
        policies,
        f.key,
        { failure: "date", conditions: {} },
        reproduction,
      ).reproduction,
    ).toEqual(reproduction);
  });
});
