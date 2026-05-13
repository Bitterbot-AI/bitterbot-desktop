import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import { skillManage } from "./skill-manage.js";
import { promoteStaged, rollbackStaged } from "./skill-promote.js";
import {
  hasStaged,
  liveSkillPath,
  listArchivedVersions,
  readArchivedVersion,
  readLive,
  resolveStorageRoots,
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
