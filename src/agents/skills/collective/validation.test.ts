import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import { learningHash, lineageId, packageHash, sha256, type PackageSnapshot } from "./contracts.js";
import { signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";
import {
  PackageValidator,
  signTest,
  isCanaryExposed,
  type PackageExecutionHost,
} from "./validation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(unused = false, regression = false, unknown = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collective-validation-"));
  const db = new DatabaseSync(":memory:");
  cleanups.push(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const store = new CollectiveSkillStore(db, root);
  const bytes = Buffer.from(
    "---\nname: brief\ndescription: Write a source-backed brief.\n---\nRead the sources and write a brief with citations and uncertainties.",
  );
  const manifest = {
    schemaVersion: 1 as const,
    name: "brief",
    description: "Write a brief.",
    entrypoint: "SKILL.md" as const,
    requirements: { platforms: [], tools: {}, capabilities: [], runtime: {} },
    files: [{ path: "SKILL.md", hash: sha256(bytes), size: bytes.length, executable: false }],
  };
  const snapshot: PackageSnapshot = {
    manifest,
    packageHash: packageHash(manifest),
    files: new Map([["SKILL.md", bytes]]),
    omitted: [],
  };
  await store.install(snapshot);
  await store.screen(snapshot.packageHash);
  const key = generateKeyPair(),
    node = `ed25519:${key.publicKeyHex}`;
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher: node,
      skillId: "brief",
      version: 1,
      packageHash: snapshot.packageHash,
      previousRelease: null,
      parents: [],
      scope: { kind: "public" },
      issuedAt: Date.now(),
    },
    key,
  );
  const cost = { providerUsd: 0, toolCalls: 1, wallMs: 1 };
  const host: PackageExecutionHost = {
    node,
    environment: {
      model: "fixture",
      tools: { brief: "1" },
      runtime: {},
      checkerHash: sha256("checker"),
    },
    tasks: Array.from({ length: 21 }, (_, i) => ({
      id: String(i),
      family: `family-${i}`,
      input: { i },
      regression: i === 20,
    })),
    acquisitionTaskHashes: new Set(),
    quote: () => cost,
    execute: async (task, candidate) => ({
      outcome: task.regression
        ? regression && candidate
          ? "task-failure"
          : "pass"
        : candidate
          ? "pass"
          : "task-failure",
      accessedFiles: candidate && !unused ? ["SKILL.md"] : [],
      cost: unknown ? null : cost,
    }),
  };
  const validator = new PackageValidator(store, host, {
    providerUsd: 0,
    toolCalls: 1000,
    wallMs: 1000,
  });
  return { store, release, host, validator };
}
it("requires measured paired improvement and verified package reads", async () => {
  const f = await setup();
  const verdict = await f.validator.validate(f.release, null, new AbortController().signal);
  expect(verdict).toMatchObject({ passed: true, pairs: 20, wins: 20, alpha: 0.025 });
  expect(f.store.get(f.release.packageHash)?.state).toBe("locally-validated");
  expect(f.validator.ledger.costs()).toMatchObject({ toolCalls: 42, unknownRuns: 0 });
  const unused = await setup(true);
  expect(
    (await unused.validator.validate(unused.release, null, new AbortController().signal)).passed,
  ).toBe(false);
});
it("blocks regression and reusing a selection instance", async () => {
  const f = await setup(false, true);
  expect(await f.validator.validate(f.release, null, new AbortController().signal)).toMatchObject({
    passed: false,
    reason: "regression-panel-failure",
  });
  await expect(f.validator.validate(f.release, null, new AbortController().signal)).rejects.toThrow(
    "already used",
  );
});
it("retains unresolved costs instead of guessing zero", async () => {
  const f = await setup(false, false, true);
  expect((await f.validator.validate(f.release, null, new AbortController().signal)).passed).toBe(
    false,
  );
  expect(f.validator.ledger.costs().unknownRuns).toBe(1);
});
it("rolls back a confirmed exposed canary failure", async () => {
  const f = await setup();
  await f.validator.validate(f.release, null, new AbortController().signal);
  f.store.activate("main", f.release, learningHash(f.host.environment));
  let run = "run";
  while (!isCanaryExposed(run, f.release.packageHash)) run += "x";
  f.validator.observeCanary(
    "main",
    lineageId(f.release),
    {
      id: run,
      runId: run,
      packageHash: f.release.packageHash,
      node: f.host.node,
      taskHash: sha256("new-task"),
      family: "new-family",
      environment: f.host.environment,
      partition: "canary",
      outcome: "task-failure",
      accessedFiles: ["SKILL.md"],
      cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
      occurredAt: Date.now(),
    },
    true,
  );
  expect(f.store.active("main", lineageId(f.release))).toBeNull();
  expect(f.store.get(f.release.packageHash)?.state).toBe("rolled-back");
});
it("computes exact one-sided sign-test probabilities", () => {
  expect(signTest(5, 0)).toBeCloseTo(0.03125);
  expect(signTest(1, 1)).toBe(1);
  expect(signTest(20, 0)).toBeCloseTo(2 ** -20);
});

it("requires 20 eligible checked canary runs and preserves the fixed panel as held-out", async () => {
  const f = await setup();
  await f.validator.validate(f.release, null, new AbortController().signal);
  const heldOut = f.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM collective_receipts WHERE json_extract(body,'$.partition')='held-out'",
    )
    .get();
  expect(heldOut?.n).toBe(2);
  f.store.activate("main", f.release, learningHash(f.host.environment));
  let eligible = 0;
  for (let index = 0; eligible < 20; index++) {
    const run = `canary-${index}`;
    if (!isCanaryExposed(run, f.release.packageHash)) continue;
    f.validator.observeCanary(
      "main",
      lineageId(f.release),
      {
        id: run,
        runId: run,
        packageHash: f.release.packageHash,
        node: f.host.node,
        taskHash: sha256(run),
        family: "canary",
        environment: f.host.environment,
        partition: "canary",
        outcome: "pass",
        accessedFiles: ["SKILL.md"],
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 1 },
        occurredAt: Date.now(),
      },
      false,
    );
    eligible++;
    expect(f.store.get(f.release.packageHash)?.state).toBe(eligible < 20 ? "canary" : "stable");
  }
});

it("leaves insufficient canary evidence incomplete and disables it on housekeeping", async () => {
  const f = await setup();
  await f.validator.validate(f.release, null, new AbortController().signal);
  f.store.activate("main", f.release, learningHash(f.host.environment));
  f.store.db.prepare("UPDATE collective_canary SET started_at=?").run(Date.now() - 15 * 86400000);
  f.validator.maintain("main");
  expect(f.store.get(f.release.packageHash)).toMatchObject({
    state: "blocked",
    reason: "canary-insufficient-evidence",
  });
  f.validator.maintain("main");
  expect(f.store.active("main", lineageId(f.release))).toBeNull();
});

it("blocks spending before execution and keeps model-drift evidence separate", async () => {
  const f = await setup();
  const validator = new PackageValidator(
    f.store,
    { ...f.host, quote: () => ({ providerUsd: 1, toolCalls: 1, wallMs: 1 }) },
    { providerUsd: 0, toolCalls: 1000, wallMs: 1000 },
  );
  expect((await validator.validate(f.release, null, new AbortController().signal)).passed).toBe(
    false,
  );
  expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM collective_receipts").get()?.n).toBe(0);
  const other = await setup();
  await other.validator.validate(other.release, null, new AbortController().signal);
  other.store.activate("main", other.release, learningHash(other.host.environment));
  new PackageValidator(
    other.store,
    { ...other.host, environment: { ...other.host.environment, model: "changed" } },
    { providerUsd: 0, toolCalls: 0, wallMs: 0 },
  ).maintain("main");
  expect(other.store.get(other.release.packageHash)?.state).toBe("stale");
  expect(other.store.get(other.release.packageHash)?.environment).toBe(
    learningHash(other.host.environment),
  );
});
