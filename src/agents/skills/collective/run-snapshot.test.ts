import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPair } from "../../../commerce/envelope.js";
import { learningHash } from "./contracts.js";
import { snapshotPackage } from "./package.js";
import { prepareCollectiveRunSnapshot, withCollectivePackageMounts } from "./run-snapshot.js";
import type { CollectiveRuntime } from "./runtime.js";
import { signRelease } from "./signatures.js";
import { CollectiveSkillStore } from "./store.js";

const state = vi.hoisted(() => ({ runtime: null as CollectiveRuntime | null }));
vi.mock("./runtime.js", () => ({ getCollectiveRuntime: () => state.runtime }));
vi.mock("./service.js", () => ({
  ensurePackageHost: async () => state.runtime?.hosts.get("main"),
}));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  state.runtime = null;
  for (const clean of cleanups.splice(0)) await clean();
});
it("pins a run to exact package paths through updates and mounts only that version read-only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-pin-")),
    db = new DatabaseSync(":memory:");
  cleanups.push(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  await fs.mkdir(source);
  const skill =
    "---\nname: brief\ndescription: Prepare a brief with citations and uncertainties.\n---\nRead sources and write a brief with source dates, recommendations and a follow-up owner.\n";
  await fs.writeFile(path.join(source, "SKILL.md"), skill);
  const metadata = {
    name: "brief",
    description: "Prepare a brief.",
    requirements: { platforms: [], tools: {}, runtime: {}, capabilities: [] },
  };
  const store = new CollectiveSkillStore(db, path.join(root, "objects"));
  const env = { model: "fixture/model", tools: {}, runtime: {}, checkerHash: "a".repeat(64) };
  state.runtime = {
    store,
    hosts: new Map([
      [
        "main",
        {
          node: "fixture",
          environment: env,
          tasks: [],
          acquisitionTaskHashes: new Set(),
          quote: () => ({ providerUsd: 0, toolCalls: 0, wallMs: 0 }),
          execute: async () => {
            throw new Error("not used");
          },
        },
      ],
    ]),
  } as CollectiveRuntime;
  const first = await snapshotPackage(source, metadata);
  await store.install(first);
  store.state(first.packageHash, "stable", null, learningHash(env));
  const key = generateKeyPair();
  const release = signRelease(
    {
      protocol: "bitterbot/skill-release/1",
      publisher: `ed25519:${key.publicKeyHex}`,
      skillId: "brief",
      version: 1,
      previousRelease: null,
      parents: [],
      packageHash: first.packageHash,
      scope: { kind: "private" },
      issuedAt: Date.now(),
    },
    key,
  );
  const id = store.addRelease(release);
  store.activate("main", release, learningHash(env));
  store.state(first.packageHash, "stable");
  const cfg = {
    skills: { collective: { enabled: true } },
    agents: { defaults: { sandbox: { mode: "all" as const } } },
  };
  const initial = await prepareCollectiveRunSnapshot(
    cfg,
    "main",
    "running-session",
    { prompt: "", skills: [], resolvedSkills: [] },
    env.model,
  );
  expect(initial?.resolvedSkills).toHaveLength(1);
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    `${skill}\nState conditional recommendations.\n`,
  );
  const second = await snapshotPackage(source, metadata);
  await store.install(second);
  store.state(second.packageHash, "stable", null, learningHash(env));
  const next = signRelease(
    {
      ...release,
      version: 2,
      packageHash: second.packageHash,
      previousRelease: id,
      parents: [first.packageHash],
    },
    key,
  );
  store.addRelease(next);
  store.activate("main", next, learningHash(env));
  const pinned = await prepareCollectiveRunSnapshot(
    cfg,
    "main",
    "running-session",
    initial,
    env.model,
  );
  expect(pinned?.resolvedSkills?.[0].filePath).toContain(first.packageHash);
  const mounted = withCollectivePackageMounts(cfg, "main", pinned, "agent:main:main");
  expect(mounted.agents?.list?.[0].sandbox?.docker?.binds).toEqual([
    `${path.join(store.directory(first.packageHash), "content")}:/bitterbot-skills/${first.packageHash}:ro`,
  ]);
  expect(pinned?.prompt).toContain(`/bitterbot-skills/${first.packageHash}/SKILL.md`);
  expect(pinned?.prompt).not.toContain(second.packageHash);
  const changed = await prepareCollectiveRunSnapshot(
    cfg,
    "main",
    "running-session",
    pinned,
    "different/model",
  );
  expect(changed?.resolvedSkills).toHaveLength(0);
});
