import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { skillBodyWithSeverity } from "./skill-gate.test.js";
import { skillManage } from "./skill-manage.js";
import { promoteStaged, rollbackStaged } from "./skill-promote.js";
import {
  hasStaged,
  liveSkillPath,
  listArchivedVersions,
  readArchivedVersion,
  liveSkillDir,
  readLive,
  readStaged,
  resolveStorageRoots,
  stagingSkillDir,
  updateStagingGateStatus,
} from "./skill-storage.js";

const SAMPLE = "---\nname: alpha\ndescription: hello\n---\n# alpha\nbody line one\nbody line two\n";
const SAMPLE_2 =
  "---\nname: alpha\ndescription: updated\n---\n# alpha\nrewritten body\nmore content here\n";

function newStore(): SkillLifecycleStore {
  const db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
  });
  runMigrations(db);
  return new SkillLifecycleStore(db);
}

async function seedLive(tmp: string, name: string, content: string): Promise<void> {
  const roots = resolveStorageRoots({ configDir: tmp });
  await fs.mkdir(path.dirname(liveSkillPath(roots, name)), { recursive: true });
  await fs.writeFile(liveSkillPath(roots, name), content, "utf-8");
}

describe("promoteStaged — gate enforcement", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-gate-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("refuses to promote when nothing is staged", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no-staged");
  });

  it("refuses to promote when gate did not pass", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "agent" },
    );
    // Manually mark the gate as failed.
    await updateStagingGateStatus(roots, "alpha", "failed", "synthetic");
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("gate-not-passed");
  });

  it("forceGate=true overrides a failed gate", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "agent" },
    );
    await updateStagingGateStatus(roots, "alpha", "failed", "synthetic");
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha", forceGate: true });
    expect(result.ok).toBe(true);
  });
});

describe("promoteStaged — regular content", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-edit-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("promotes a brand-new skill (no prior live) to live", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "agent" },
    );
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("edit");
    expect(result.previousArchived).toBeNull();
    expect(await readLive(roots, "alpha")).toBe(SAMPLE);
    expect(await hasStaged(roots, "alpha")).toBe(false);
  });

  it("snapshots previous live to archive before overwriting", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    await skillManage(
      { storageRoots: roots },
      {
        action: "edit",
        name: "alpha",
        content: SAMPLE_2,
        reason: "refactor",
        author: "agent",
      },
    );
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(true);
    expect(result.previousArchived?.version).toBe(1);
    expect(await readLive(roots, "alpha")).toBe(SAMPLE_2);
    const archived = await readArchivedVersion(roots, "alpha", 1);
    expect(archived?.content).toBe(SAMPLE);
  });
});

describe("promoteStaged — tombstone", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-tombstone-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("archives live and removes it from disk", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const store = newStore();
    store.recordUsage({ skillName: "alpha", success: true, origin: "agent_authored" });
    await seedLive(tmp, "alpha", SAMPLE);
    await skillManage(
      { storageRoots: roots },
      { action: "delete", name: "alpha", reason: "obsolete", author: "agent" },
    );
    const result = await promoteStaged(
      { storageRoots: roots, lifecycleStore: store },
      { name: "alpha" },
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("tombstone");
    expect(result.previousArchived?.version).toBe(1);
    expect(await readLive(roots, "alpha")).toBeNull();
    expect(await hasStaged(roots, "alpha")).toBe(false);
    expect(store.get("alpha")?.state).toBe("archived");
  });

  it("errors when no live exists to delete", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    // Force-stage a tombstone via raw stageSkill bypassing the live check.
    // We use skill-manage delete and seed live first, then delete the file
    // manually to simulate the race.
    await seedLive(tmp, "alpha", SAMPLE);
    await skillManage(
      { storageRoots: roots },
      { action: "delete", name: "alpha", reason: "x", author: "agent" },
    );
    await fs.unlink(liveSkillPath(roots, "alpha"));
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tombstone-no-live");
  });
});

describe("promoteStaged — consolidate", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-consolidate-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("archives source, removes source from live, and consolidates lifecycle", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const store = newStore();
    store.recordUsage({ skillName: "alpha", success: true, origin: "agent_authored" });
    store.recordUsage({ skillName: "beta", success: true, origin: "agent_authored" });
    await seedLive(tmp, "alpha", SAMPLE);
    await seedLive(tmp, "beta", SAMPLE);

    await skillManage(
      { storageRoots: roots },
      {
        action: "consolidate",
        name: "alpha",
        into: "beta",
        reason: "duplicate",
        author: "agent",
      },
    );
    const result = await promoteStaged(
      { storageRoots: roots, lifecycleStore: store },
      { name: "alpha" },
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("consolidate");
    expect(await readLive(roots, "alpha")).toBeNull();
    expect(await readLive(roots, "beta")).toBe(SAMPLE); // target untouched
    const alpha = store.get("alpha");
    expect(alpha?.state).toBe("archived");
    expect(alpha?.consolidatedInto).toBe("beta");
  });

  it("errors when target is no longer live at promote time", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    await seedLive(tmp, "beta", SAMPLE);
    await skillManage(
      { storageRoots: roots },
      {
        action: "consolidate",
        name: "alpha",
        into: "beta",
        reason: "x",
        author: "agent",
      },
    );
    // Remove target between stage and promote.
    await fs.unlink(liveSkillPath(roots, "beta"));
    const result = await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("consolidate-target-missing");
  });
});

describe("rollbackStaged", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-rollback-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("restores an archived version and snapshots current live first", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const store = newStore();
    await seedLive(tmp, "alpha", SAMPLE);
    // Edit twice to produce v1.
    await skillManage(
      { storageRoots: roots },
      {
        action: "edit",
        name: "alpha",
        content: SAMPLE_2,
        reason: "first edit",
        author: "agent",
      },
    );
    await promoteStaged({ storageRoots: roots }, { name: "alpha" });
    expect((await listArchivedVersions(roots, "alpha")).length).toBe(1);

    const result = await rollbackStaged(
      { storageRoots: roots, lifecycleStore: store },
      { name: "alpha", version: 1, reason: "regression test" },
    );
    expect(result.ok).toBe(true);
    expect(result.restoredContent).toBe(SAMPLE);
    expect(await readLive(roots, "alpha")).toBe(SAMPLE);
    // Pre-rollback live (the SAMPLE_2 edit) becomes v2.
    expect(result.previousArchived?.version).toBe(2);
  });

  it("errors when target version is missing", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await rollbackStaged({ storageRoots: roots }, { name: "alpha", version: 99 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("storage-error");
  });
});

describe("PLAN-44 Phase 3 (I7): evolution-staged content", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-evo-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function stageEvolved(roots: ReturnType<typeof resolveStorageRoots>) {
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "evolution" },
    );
    const dir = stagingSkillDir(roots, "alpha");
    await fs.writeFile(
      path.join(dir, ".evolution-meta.json"),
      JSON.stringify({ origin: "wiki-evolution", stagedAt: 1 }),
      "utf-8",
    );
    await fs.writeFile(path.join(dir, "PURPOSE.md"), "# why\nbecause\n", "utf-8");
  }

  it("refuses promote (even with forceGate) unless allowEvolutionStaged is set", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageEvolved(roots);
    const plain = await promoteStaged(
      { storageRoots: roots },
      { name: "alpha", author: "agent:main" },
    );
    expect(plain.ok).toBe(false);
    expect(plain.error).toBe("evolution-staged");
    const forced = await promoteStaged({ storageRoots: roots }, { name: "alpha", forceGate: true });
    expect(forced.error).toBe("evolution-staged");
    expect(await readLive(roots, "alpha")).toBeNull();
    expect(await readStaged(roots, "alpha")).not.toBeNull();
  });

  it("carries .evolution-meta.json and PURPOSE.md to the live dir when the gate promotes", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageEvolved(roots);
    const result = await promoteStaged(
      { storageRoots: roots },
      { name: "alpha", author: "evolution", allowEvolutionStaged: true },
    );
    expect(result.ok).toBe(true);
    const live = liveSkillDir(roots, "alpha");
    expect(
      JSON.parse(await fs.readFile(path.join(live, ".evolution-meta.json"), "utf-8")),
    ).toMatchObject({
      origin: "wiki-evolution",
    });
    expect(await fs.readFile(path.join(live, "PURPOSE.md"), "utf-8")).toContain("because");
    expect(await readStaged(roots, "alpha")).toBeNull();
  });

  it("skillManage strictInjection: a medium hit fails the staging gate for evolution content", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const suspect = skillBodyWithSeverity("medium");
    const lenient = await skillManage(
      { storageRoots: roots },
      { action: "create", name: "beta", content: suspect, reason: "x", author: "user" },
    );
    expect(lenient.ok).toBe(true);
    const strict = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "gamma",
        content: suspect,
        reason: "x",
        author: "evolution",
        strictInjection: true,
      },
    );
    expect(strict.ok).toBe(false);
    expect(strict.error).toBe("gate-failed");
    expect((await readStaged(roots, "gamma"))?.meta.gateStatus).toBe("failed");
  });
});

describe("PLAN-44 Phase 3 adversarial fixes: provenance cannot be hijacked or linger", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-promote-adv-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("H1: an agent edit over an evolution-staged name strips the sidecars, so it is a plain staged edit", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "evolution" },
    );
    const dir = stagingSkillDir(roots, "alpha");
    await fs.writeFile(
      path.join(dir, ".evolution-meta.json"),
      JSON.stringify({ origin: "wiki-evolution" }),
    );
    await fs.writeFile(path.join(dir, "PURPOSE.md"), "# why\n");
    const edit = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "alpha",
        content: SAMPLE_2,
        reason: "hijack",
        author: "agent:main",
      },
    );
    expect(edit.ok).toBe(true);
    await expect(fs.access(path.join(dir, ".evolution-meta.json"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "PURPOSE.md"))).rejects.toThrow();
    // ...and therefore promotes as ordinary agent content, with no evolution identity.
    const promoted = await promoteStaged(
      { storageRoots: roots },
      { name: "alpha", author: "agent:main" },
    );
    expect(promoted.ok).toBe(true);
    await expect(
      fs.access(path.join(liveSkillDir(roots, "alpha"), ".evolution-meta.json")),
    ).rejects.toThrow();
  });

  it("L10: a later non-evolution promote over an evolved live skill removes the live sidecars", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await skillManage(
      { storageRoots: roots },
      { action: "create", name: "alpha", content: SAMPLE, reason: "x", author: "evolution" },
    );
    const dir = stagingSkillDir(roots, "alpha");
    await fs.writeFile(
      path.join(dir, ".evolution-meta.json"),
      JSON.stringify({ origin: "wiki-evolution" }),
    );
    await promoteStaged(
      { storageRoots: roots },
      { name: "alpha", author: "evolution", allowEvolutionStaged: true },
    );
    const live = liveSkillDir(roots, "alpha");
    await fs.access(path.join(live, ".evolution-meta.json"));
    await skillManage(
      { storageRoots: roots },
      { action: "edit", name: "alpha", content: SAMPLE_2, reason: "human rewrite", author: "user" },
    );
    const promoted = await promoteStaged(
      { storageRoots: roots },
      { name: "alpha", author: "user" },
    );
    expect(promoted.ok).toBe(true);
    await expect(fs.access(path.join(live, ".evolution-meta.json"))).rejects.toThrow();
    expect(await readLive(roots, "alpha")).toBe(SAMPLE_2);
  });
});
