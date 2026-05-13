import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryIndexSchema } from "../../memory/memory-schema.js";
import { runMigrations } from "../../memory/migrations.js";
import { SkillLifecycleStore } from "../../memory/skill-lifecycle.js";
import {
  applySubstringPatch,
  readConsolidateTarget,
  readStagedForPublish,
  skillManage,
  stagedIsConsolidateManifest,
  stagedIsTombstone,
} from "./skill-manage.js";
import { hasStaged, liveSkillPath, resolveStorageRoots } from "./skill-storage.js";

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

describe("applySubstringPatch", () => {
  it("replaces a single match", () => {
    const out = applySubstringPatch({
      source: "hello world",
      oldString: "world",
      newString: "universe",
    });
    expect(out).toEqual({ content: "hello universe", replacedCount: 1 });
  });

  it("returns ambiguous when oldString appears multiple times", () => {
    const out = applySubstringPatch({
      source: "abc abc abc",
      oldString: "abc",
      newString: "xyz",
    });
    expect(out).toMatchObject({ error: "patch-ambiguous" });
  });

  it("replaces every occurrence with replaceAll=true", () => {
    const out = applySubstringPatch({
      source: "abc abc abc",
      oldString: "abc",
      newString: "xyz",
      replaceAll: true,
    });
    expect(out).toEqual({ content: "xyz xyz xyz", replacedCount: 3 });
  });

  it("returns no-match when oldString is absent", () => {
    const out = applySubstringPatch({
      source: "hello",
      oldString: "missing",
      newString: "x",
    });
    expect(out).toMatchObject({ error: "patch-no-match" });
  });

  it("rejects empty oldString", () => {
    const out = applySubstringPatch({
      source: "hello",
      oldString: "",
      newString: "x",
    });
    expect(out).toMatchObject({ error: "patch-no-match" });
  });
});

describe("skillManage — create", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-manage-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stages a new skill when live is empty", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "alpha",
        content: SAMPLE,
        reason: "first",
        author: "agent",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.stagedFilePath).toBeTruthy();
    expect(result.gate?.outcome).toBe("pass");
    expect(await hasStaged(roots, "alpha")).toBe(true);
  });

  it("refuses to overwrite live by default", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "alpha",
        content: SAMPLE_2,
        reason: "clobber",
        author: "agent",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("live-exists");
  });

  it("allows overwrite when overwriteLive=true", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "alpha",
        content: SAMPLE_2,
        reason: "clobber",
        author: "agent",
        overwriteLive: true,
      },
    );
    expect(result.ok).toBe(true);
  });

  it("fails the gate on missing frontmatter", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "create",
        name: "alpha",
        content: "no frontmatter here",
        reason: "bad",
        author: "agent",
      },
    );
    // Note: stageSkill itself rejects content without frontmatter, returning
    // storage-error rather than gate-failed.
    expect(result.ok).toBe(false);
    expect(result.error === "storage-error" || result.error === "gate-failed").toBe(true);
  });
});

describe("skillManage — edit", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-manage-edit-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("refuses to edit when no live skill exists", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await skillManage(
      { storageRoots: roots },
      { action: "edit", name: "ghost", content: SAMPLE, reason: "x", author: "agent" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("live-missing");
  });

  it("stages an edit against a live skill", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "edit",
        name: "alpha",
        content: SAMPLE_2,
        reason: "refactor",
        author: "agent",
      },
    );
    expect(result.ok).toBe(true);
    expect(result.gate?.outcome).toBe("pass");
  });

  it("fails the gate on a high-baseline + high-diff edit without override", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(
      tmp,
      "alpha",
      "---\nname: alpha\ndescription: x\n---\nline-A\nline-B\nline-C\nline-D\nline-E\n",
    );
    const lifecycleStore = newStore();
    for (let i = 0; i < 10; i++) {
      lifecycleStore.recordUsage({
        skillName: "alpha",
        success: true,
        origin: "agent_authored",
        timestamp: 1000 + i,
      });
    }
    const result = await skillManage(
      { storageRoots: roots, lifecycleStore },
      {
        action: "edit",
        name: "alpha",
        content:
          "---\nname: alpha\ndescription: x\n---\nfresh-A\nfresh-B\nfresh-C\nfresh-D\nfresh-E\n",
        reason: "refactor",
        author: "agent",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("gate-failed");
    expect(result.gate?.outcome).toBe("fail");
  });

  it("allows the same edit when acceptHighRiskDiff=true", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(
      tmp,
      "alpha",
      "---\nname: alpha\ndescription: x\n---\nline-A\nline-B\nline-C\nline-D\nline-E\n",
    );
    const lifecycleStore = newStore();
    for (let i = 0; i < 10; i++) {
      lifecycleStore.recordUsage({
        skillName: "alpha",
        success: true,
        origin: "agent_authored",
        timestamp: 1000 + i,
      });
    }
    const result = await skillManage(
      { storageRoots: roots, lifecycleStore },
      {
        action: "edit",
        name: "alpha",
        content:
          "---\nname: alpha\ndescription: x\n---\nfresh-A\nfresh-B\nfresh-C\nfresh-D\nfresh-E\n",
        reason: "refactor",
        author: "agent",
        acceptHighRiskDiff: true,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.gate?.outcome).toBe("warn");
  });
});

describe("skillManage — patch", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-manage-patch-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stages a single-substring patch on live", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "patch",
        name: "alpha",
        oldString: "body line two",
        newString: "body line TWO!!!",
        reason: "tweak",
        author: "agent",
      },
    );
    expect(result.ok).toBe(true);
    const staged = await readStagedForPublish(roots, "alpha");
    expect(staged?.content).toContain("body line TWO!!!");
  });

  it("returns ambiguous when patch matches multiple times without replaceAll", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", "---\nname: alpha\ndescription: x\n---\nfoo\nfoo\nfoo\n");
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "patch",
        name: "alpha",
        oldString: "foo",
        newString: "bar",
        reason: "x",
        author: "agent",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("patch-ambiguous");
  });

  it("returns no-match for absent oldString", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      {
        action: "patch",
        name: "alpha",
        oldString: "nowhere",
        newString: "x",
        reason: "x",
        author: "agent",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("patch-no-match");
  });
});

describe("skillManage — delete", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-manage-delete-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stages a tombstone when live exists", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      { action: "delete", name: "alpha", reason: "no longer needed", author: "agent" },
    );
    expect(result.ok).toBe(true);
    const staged = await readStagedForPublish(roots, "alpha");
    expect(staged?.content).toContain("tombstone");
    expect(staged && stagedIsTombstone(staged.content)).toBe(true);
    expect(staged?.gateOutcome).toBe("passed");
  });

  it("refuses to stage delete when no live exists", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    const result = await skillManage(
      { storageRoots: roots },
      { action: "delete", name: "ghost", reason: "x", author: "agent" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("live-missing");
  });
});

describe("skillManage — consolidate", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skill-manage-consolidate-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("stages a consolidate manifest when target exists", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    await seedLive(tmp, "beta", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      { action: "consolidate", name: "alpha", into: "beta", reason: "duplicate", author: "agent" },
    );
    expect(result.ok).toBe(true);
    const staged = await readStagedForPublish(roots, "alpha");
    expect(staged && stagedIsConsolidateManifest(staged.content)).toBe(true);
    expect(staged && readConsolidateTarget(staged.content)).toBe("beta");
  });

  it("refuses to consolidate when target is missing", async () => {
    const roots = resolveStorageRoots({ configDir: tmp });
    await seedLive(tmp, "alpha", SAMPLE);
    const result = await skillManage(
      { storageRoots: roots },
      { action: "consolidate", name: "alpha", into: "ghost", reason: "x", author: "agent" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("consolidate-target-missing");
  });
});

describe("staged content discriminators", () => {
  it("stagedIsTombstone matches only the tombstone prefix", () => {
    expect(stagedIsTombstone("---\n# skill_manage tombstone\nname: x")).toBe(true);
    expect(stagedIsTombstone("---\nname: x\n---\nbody")).toBe(false);
  });
  it("stagedIsConsolidateManifest matches only the consolidate prefix", () => {
    expect(stagedIsConsolidateManifest("---\n# skill_manage consolidate manifest\nname: x")).toBe(
      true,
    );
    expect(stagedIsConsolidateManifest("---\nname: x\n---\nbody")).toBe(false);
  });
  it("readConsolidateTarget extracts the into field", () => {
    const manifest =
      '---\n# skill_manage consolidate manifest\nname: alpha\nconsolidate:\n  into: "beta"\n  reason: "x"\n---\nbody';
    expect(readConsolidateTarget(manifest)).toBe("beta");
  });
  it("readConsolidateTarget returns null for non-manifests", () => {
    expect(readConsolidateTarget("---\nname: x\n---")).toBeNull();
  });
});
