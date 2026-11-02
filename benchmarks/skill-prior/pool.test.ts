import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reorderSkillsPrompt, skillOrderInPrompt } from "../../src/agents/skills/skill-prior.js";
import { buildWorkspaceSkillSnapshot } from "../../src/agents/skills/workspace.js";
import { FAMILIES, POOL, POOL_NAMES, poolByFamily, poolSkillFromPath, writePool } from "./pool.js";
import { familyOfTask, instancesForSeed, seedsIn, splitOfSeed } from "./tasks.js";

let root: string;
let poolRoot: string;
let emptyRoot: string;
let workspace: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-prior-pool-"));
  poolRoot = await writePool(path.join(root, "pool"));
  emptyRoot = path.join(root, "empty");
  workspace = path.join(root, "ws");
  await fs.mkdir(emptyRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("skill pool", () => {
  it("has one correct and one decoy per family, unique contract-shaped descriptions", () => {
    for (const fam of FAMILIES) {
      const { correct, decoy } = poolByFamily(fam);
      expect(correct.name).not.toBe(decoy.name);
      expect(correct.body).not.toBe(decoy.body);
    }
    expect(new Set(POOL_NAMES).size).toBe(POOL.length);
    for (const s of POOL) {
      expect(s.name).toMatch(/^xp-[a-z0-9-]+$/);
      expect(s.description).toMatch(/^Use when .* Not for /);
      expect(s.description.length).toBeLessThanOrEqual(240);
    }
  });

  it("loads through the real skills pathway with the pool as the only root", () => {
    const snapshot = buildWorkspaceSkillSnapshot(workspace, {
      managedSkillsDir: poolRoot,
      bundledSkillsDir: emptyRoot,
      skillFilter: [...POOL_NAMES],
    });
    const order = skillOrderInPrompt(snapshot.prompt);
    expect(order.toSorted()).toEqual([...POOL_NAMES].toSorted());
    expect(snapshot.resolvedSkills?.every((s) => s.filePath.startsWith(poolRoot))).toBe(true);
    const { correct, decoy } = poolByFamily("ledger-sum");
    const reordered = reorderSkillsPrompt(snapshot.prompt, [correct.name, decoy.name]);
    expect(skillOrderInPrompt(reordered).slice(0, 2)).toEqual([correct.name, decoy.name]);
    expect(reordered.length).toBe(snapshot.prompt.length);
  });

  it("loads from a workspace skills/ root with the managed and bundled roots empty", async () => {
    const ws = path.join(root, "ws2");
    await writePool(
      path.join(ws, "skills"),
      POOL.filter((s) => s.family === "ledger-sum"),
    );
    const snapshot = buildWorkspaceSkillSnapshot(ws, {
      managedSkillsDir: emptyRoot,
      bundledSkillsDir: emptyRoot,
      skillFilter: [...POOL_NAMES],
    });
    const names = skillOrderInPrompt(snapshot.prompt);
    expect(names.toSorted()).toEqual(
      POOL.filter((s) => s.family === "ledger-sum")
        .map((s) => s.name)
        .toSorted(),
    );
    expect(snapshot.resolvedSkills?.every((s) => s.filePath.startsWith(ws))).toBe(true);
  });

  it("an empty filter sentinel yields an empty index", () => {
    const snapshot = buildWorkspaceSkillSnapshot(workspace, {
      managedSkillsDir: poolRoot,
      bundledSkillsDir: emptyRoot,
      skillFilter: ["__none__"],
    });
    expect(skillOrderInPrompt(snapshot.prompt)).toEqual([]);
  });

  it("maps read paths back to pool skills", () => {
    const { correct } = poolByFamily("json-path");
    expect(poolSkillFromPath(poolRoot, path.join(poolRoot, correct.name, "SKILL.md"))).toBe(
      correct.name,
    );
    expect(poolSkillFromPath(poolRoot, path.join(poolRoot, "not-a-skill", "SKILL.md"))).toBeNull();
    expect(poolSkillFromPath(poolRoot, "/etc/passwd")).toBeNull();
  });
});

describe("tasks", () => {
  it("draws one instance per family per seed with the family tag and a seeded id", () => {
    const instances = instancesForSeed(7);
    expect(instances.map((i) => i.family)).toEqual([...FAMILIES]);
    for (const inst of instances) {
      expect(inst.task.id.endsWith("-s7")).toBe(true);
      expect(familyOfTask(inst.task)).toBe(inst.family);
      expect(inst.task.checker.kind).toBe("final");
    }
    const again = instancesForSeed(7);
    expect(again[0]!.task.prompt).toBe(instances[0]!.task.prompt);
    expect(instancesForSeed(8)[0]!.task.prompt).not.toBe(instances[0]!.task.prompt);
  });

  it("partitions seeds deterministically and disjointly", () => {
    const dev = seedsIn("development", 1, 20);
    const qual = seedsIn("qualification", 1, 10);
    expect(dev).toHaveLength(20);
    expect(dev.some((s) => qual.includes(s))).toBe(false);
    for (const s of dev) {
      expect(splitOfSeed(s)).toBe("development");
    }
  });
});
