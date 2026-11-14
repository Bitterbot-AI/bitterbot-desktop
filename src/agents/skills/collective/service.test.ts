import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import type { BitterbotConfig } from "../../../config/config.js";
import { learningHash, lineageId, sha256 } from "./contracts.js";
import { PeerEvidenceStore } from "./evidence.js";
import { snapshotPackage } from "./package.js";
import { SkillPolicyService } from "./policy.js";
import type { CollectiveRuntime } from "./runtime.js";
import { queueAuthorizedDiscoveries, workPackageQueue } from "./service.js";
import { signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";
import { PackageDistribution } from "./transport.js";

const state = vi.hoisted(() => ({
  runtime: null as CollectiveRuntime | null,
  privateKeyPem: "",
  config: {
    skills: {
      collective: {
        enabled: true,
        publicMesh: true,
        synthesis: "off",
        budget: { providerUsd: 0, toolCalls: 1000, wallMs: 10000 },
      },
    },
  } as BitterbotConfig,
}));
vi.mock("./runtime.js", () => ({
  getCollectiveRuntime: () => state.runtime,
  registerCollectiveMembership: () => {},
}));
vi.mock("./mesh.js", () => ({
  getPackageMesh: () => ({
    transport: () => ({
      announce: async () => {},
      fetch: async () => {
        throw new Error("No download expected for preinstalled bytes");
      },
    }),
  }),
}));
vi.mock("../../../infra/device-identity.js", async (original) => ({
  ...(await original<object>()),
  loadOrCreateDeviceIdentity: () => ({ privateKeyPem: state.privateKeyPem }),
}));
vi.mock("../../../config/config.js", async (original) => ({
  ...(await original<object>()),
  loadConfig: () => state.config,
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  state.runtime = null;
  for (const run of cleanup.splice(0)) await run();
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collective-worker-")),
    db = new DatabaseSync(":memory:");
  cleanup.push(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new CollectiveSkillStore(db, root),
    policies = new SkillPolicyService(store, () => true);
  const receiver = generateKeyPair();
  state.privateKeyPem = receiver.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const snapshot = await snapshotPackage(
    path.resolve("test/fixtures/collective-learning/research-brief"),
    {
      name: "research-brief",
      description: "Source-backed briefs.",
      requirements: { platforms: [], tools: {}, capabilities: [], runtime: {} },
    },
  );
  await store.install(snapshot);
  const author = generateKeyPair();
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher: `ed25519:${author.publicKeyHex}`,
      skillId: "brief",
      version: 1,
      packageHash: snapshot.packageHash,
      previousRelease: null,
      parents: [],
      scope: { kind: "public" },
      issuedAt: Date.now(),
    },
    author,
  );
  const id = store.addRelease(release);
  policies.set({
    id: "trusted",
    scope: release.scope,
    enabled: true,
    agents: ["main"],
    publishers: [release.publisher],
    skillIds: ["brief"],
    operations: ["evaluate", "adopt"],
    categories: ["skill-package"],
    capabilities: [],
    budget: { providerUsd: 0, toolCalls: 1000, wallMs: 10000 },
    expiresAt: Date.now() + 600000,
  });
  const execute = vi.fn(async (task: { regression: boolean }, candidate: unknown) => ({
    outcome: task.regression || candidate ? ("pass" as const) : ("task-failure" as const),
    accessedFiles: candidate ? ["SKILL.md"] : [],
    cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
  }));
  const host = {
    node: `ed25519:${receiver.publicKeyHex}`,
    environment: { model: "fixture", tools: {}, runtime: {}, checkerHash: sha256("host-checker") },
    tasks: Array.from({ length: 21 }, (_, i) => ({
      id: String(i),
      family: String(i),
      input: { i },
      regression: i === 20,
    })),
    acquisitionTaskHashes: new Set<string>(),
    quote: () => ({ providerUsd: 0, toolCalls: 1, wallMs: 1 }),
    execute,
  };
  state.runtime = {
    store,
    policies,
    hosts: new Map([["main", host]]),
    distribution: new PackageDistribution(store, policies),
    evidence: new PeerEvidenceStore(store),
  };
  return { store, policies, execute, release, id, host };
}

it("automatically validates and adopts a discovered release under independent grants", async () => {
  const f = await setup();
  await workPackageQueue(state.config);
  expect(f.store.get(f.release.packageHash)?.state).toBe("locally-validated");
  expect(f.execute).toHaveBeenCalledTimes(42);
  await workPackageQueue(state.config);
  expect(f.store.active("main", lineageId(f.release))?.hash).toBe(f.release.packageHash);
  expect(f.store.get(f.release.packageHash)?.environment).toBe(learningHash(f.host.environment));
  expect(
    f.store.db.prepare("SELECT state FROM collective_operations WHERE action='canary'").get()
      ?.state,
  ).toBe("queued");
});

it("rechecks revocation before executing a previously authorized queued job", async () => {
  const f = await setup();
  queueAuthorizedDiscoveries(state.runtime!);
  f.policies.revoke("trusted");
  await workPackageQueue(state.config);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.store.active("main", lineageId(f.release))).toBeNull();
  expect(
    f.store.db.prepare("SELECT state FROM collective_operations WHERE release_id=?").get(f.id)
      ?.state,
  ).toBe("blocked");
});
