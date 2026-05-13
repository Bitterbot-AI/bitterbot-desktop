import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveVersion,
  assertValidSkillName,
  discardStaged,
  hasStaged,
  liveSkillPath,
  listArchivedVersions,
  MAX_SKILL_CONTENT_BYTES,
  publishStaged,
  readArchivedVersion,
  readLive,
  readStaged,
  resolveStorageRoots,
  rollbackToVersion,
  SkillStorageError,
  stageSkill,
  updateStagingGateStatus,
} from "./skill-storage.js";

const SAMPLE = "---\nname: alpha\ndescription: t\n---\nbody\n";
const SAMPLE_2 = "---\nname: alpha\ndescription: t2\n---\nbody2\n";

describe("assertValidSkillName", () => {
  it("accepts simple kebab/dot/underscore names", () => {
    for (const n of ["a", "alpha", "alpha-beta", "alpha.beta", "alpha_beta", "a1b2"]) {
      expect(() => assertValidSkillName(n)).not.toThrow();
    }
  });

  it("rejects empties, slashes, dotdot, uppercase, leading punctuation", () => {
    for (const n of ["", "  ", "../etc", "a/b", "a\\b", "Alpha", "-leading", ".leading"]) {
      try {
        assertValidSkillName(n);
        throw new Error(`expected ${JSON.stringify(n)} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(SkillStorageError);
      }
    }
  });

  it("rejects names longer than 64 chars", () => {
    expect(() => assertValidSkillName("a".repeat(65))).toThrow(SkillStorageError);
  });
});

describe("stageSkill / readStaged / discardStaged", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-storage-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("writes a staging file plus metadata", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const { filePath } = await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "test",
      author: "agent",
      timestamp: 1000,
    });
    expect(await fs.readFile(filePath, "utf-8")).toBe(SAMPLE);
    expect(await hasStaged(roots, "alpha")).toBe(true);

    const staged = await readStaged(roots, "alpha");
    expect(staged?.content).toBe(SAMPLE);
    expect(staged?.meta.reason).toBe("test");
    expect(staged?.meta.author).toBe("agent");
    expect(staged?.meta.stagedAt).toBe(1000);
    expect(staged?.meta.gateStatus).toBe("pending");
  });

  it("refuses overwrite by default and accepts overwrite=true", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "first",
      author: "agent",
    });
    await expect(
      stageSkill(roots, {
        name: "alpha",
        content: SAMPLE_2,
        reason: "second",
        author: "agent",
      }),
    ).rejects.toBeInstanceOf(SkillStorageError);
    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE_2,
      reason: "second",
      author: "agent",
      overwrite: true,
    });
    const staged = await readStaged(roots, "alpha");
    expect(staged?.content).toBe(SAMPLE_2);
  });

  it("rejects content missing frontmatter", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await expect(
      stageSkill(roots, { name: "alpha", content: "no fm", reason: "x", author: "a" }),
    ).rejects.toMatchObject({ code: "missing-frontmatter" });
  });

  it("rejects content exceeding the size cap", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const huge = `---\nname: alpha\ndescription: x\n---\n${"a".repeat(MAX_SKILL_CONTENT_BYTES)}`;
    await expect(
      stageSkill(roots, { name: "alpha", content: huge, reason: "x", author: "a" }),
    ).rejects.toMatchObject({ code: "content-too-large" });
  });

  it("rejects path traversal in name", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await expect(
      stageSkill(roots, {
        name: "../escape",
        content: SAMPLE,
        reason: "x",
        author: "a",
      }),
    ).rejects.toMatchObject({ code: "invalid-name" });
  });

  it("updateStagingGateStatus mutates gate fields without losing other meta", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "orig",
      author: "agent",
      timestamp: 1000,
    });
    await updateStagingGateStatus(roots, "alpha", "failed", "boom");
    const staged = await readStaged(roots, "alpha");
    expect(staged?.meta.gateStatus).toBe("failed");
    expect(staged?.meta.gateFailureReason).toBe("boom");
    expect(staged?.meta.reason).toBe("orig");
    expect(staged?.meta.stagedAt).toBe(1000);
  });

  it("discardStaged removes the staging directory", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "x",
      author: "a",
    });
    expect(await discardStaged(roots, "alpha")).toBe(true);
    expect(await hasStaged(roots, "alpha")).toBe(false);
  });
});

describe("archiveVersion / listArchivedVersions / readArchivedVersion", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-storage-archive-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("monotonically increments the version counter", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const v1 = await archiveVersion(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "first",
      author: "agent",
    });
    const v2 = await archiveVersion(roots, {
      name: "alpha",
      content: SAMPLE_2,
      reason: "second",
      author: "agent",
    });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    const list = await listArchivedVersions(roots, "alpha");
    expect(list.map((v) => v.version)).toEqual([1, 2]);
  });

  it("reads back archived content + meta", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await archiveVersion(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "first",
      author: "agent",
      timestamp: 1000,
    });
    const read = await readArchivedVersion(roots, "alpha", 1);
    expect(read?.content).toBe(SAMPLE);
    expect(read?.meta.reason).toBe("first");
    expect(read?.meta.archivedAt).toBe(1000);
  });

  it("returns null when version is missing or invalid", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    expect(await readArchivedVersion(roots, "alpha", 1)).toBeNull();
    expect(await readArchivedVersion(roots, "alpha", 0)).toBeNull();
    expect(await readArchivedVersion(roots, "alpha", -1)).toBeNull();
  });

  it("listArchivedVersions returns empty when nothing archived", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    expect(await listArchivedVersions(roots, "alpha")).toEqual([]);
  });
});

describe("publishStaged", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-storage-publish-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("moves staged → live; no archive entry when no prior live", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "x",
      author: "a",
    });
    const result = await publishStaged(roots, {
      name: "alpha",
      reason: "publish",
      author: "user",
    });
    expect(result.previousArchived).toBeNull();
    expect(await readLive(roots, "alpha")).toBe(SAMPLE);
    expect(await hasStaged(roots, "alpha")).toBe(false);
  });

  it("snapshots prior live to archive before overwriting", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    // Seed live with content directly.
    await fs.mkdir(path.dirname(liveSkillPath(roots, "alpha")), { recursive: true });
    await fs.writeFile(liveSkillPath(roots, "alpha"), SAMPLE, "utf-8");

    await stageSkill(roots, {
      name: "alpha",
      content: SAMPLE_2,
      reason: "x",
      author: "a",
    });
    const result = await publishStaged(roots, {
      name: "alpha",
      reason: "publish",
      author: "user",
    });
    expect(result.previousArchived?.version).toBe(1);
    expect(await readLive(roots, "alpha")).toBe(SAMPLE_2);
    const archived = await readArchivedVersion(roots, "alpha", 1);
    expect(archived?.content).toBe(SAMPLE);
  });

  it("throws when nothing is staged", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await expect(
      publishStaged(roots, { name: "alpha", reason: "x", author: "a" }),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("rollbackToVersion", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-storage-rollback-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("restores an archived version into live and snapshots current live first", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    // Setup: live=SAMPLE_2, archive v1=SAMPLE.
    await fs.mkdir(path.dirname(liveSkillPath(roots, "alpha")), { recursive: true });
    await fs.writeFile(liveSkillPath(roots, "alpha"), SAMPLE_2, "utf-8");
    await archiveVersion(roots, {
      name: "alpha",
      content: SAMPLE,
      reason: "x",
      author: "a",
    });

    const result = await rollbackToVersion(roots, {
      name: "alpha",
      version: 1,
      reason: "test rollback",
      author: "user",
    });
    expect(result.restoredContent).toBe(SAMPLE);
    expect(await readLive(roots, "alpha")).toBe(SAMPLE);
    // Pre-rollback live was archived.
    expect(result.previousArchived?.version).toBe(2);
    const v2 = await readArchivedVersion(roots, "alpha", 2);
    expect(v2?.content).toBe(SAMPLE_2);
  });

  it("throws when target version does not exist", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await expect(
      rollbackToVersion(roots, {
        name: "alpha",
        version: 99,
        reason: "x",
        author: "a",
      }),
    ).rejects.toMatchObject({ code: "not-found" });
  });
});
