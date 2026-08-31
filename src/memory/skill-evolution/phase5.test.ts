import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EvolutionMeta } from "./validation-gate.js";
import { readProvenance } from "../../agents/skills/impact-trail.js";
import { resolveStorageRoots } from "../../agents/skills/skill-storage.js";
import { listP2pEligibleEvolvedSkills, publishEligibleEvolvedSkills } from "./p2p-publish.js";
import { collectEvolutionStatus } from "./status.js";
import { runWikiLint } from "./wiki-lint.js";
import { applyMaintainerOutput, listPatternNames, type MaintainerOutput } from "./wiki-store.js";

const DAY = 24 * 60 * 60 * 1000;

function out(partial: Partial<MaintainerOutput>): MaintainerOutput {
  return {
    createPatterns: [],
    updatePatterns: [],
    updateIndex: "- index",
    appendLog: "log",
    ...partial,
  };
}

async function writeEvolvedLiveSkill(
  tmpDir: string,
  name: string,
  meta: Partial<EvolutionMeta> & { published?: { at: number } },
): Promise<void> {
  const roots = resolveStorageRoots({ configDir: tmpDir });
  const dir = path.join(roots.liveRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: d\n---\nbody`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, ".evolution-meta.json"),
    JSON.stringify({ origin: "wiki-evolution", ...meta }, null, 2),
    "utf-8",
  );
}

describe("wiki lint", () => {
  let tmpDir: string;
  const opts = () => ({ configDir: tmpDir });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lint-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("archives exact duplicates and over-cap patterns, flags orphans, never deletes", async () => {
    await applyMaintainerOutput(
      out({
        createPatterns: [
          { name: "aaa", content: "same content" },
          { name: "bbb", content: "same content" },
          { name: "ccc", content: "unique 1" },
          { name: "ddd", content: "unique 2" },
        ],
        updateIndex: "- [ccc](patterns/ccc.md): only ccc is indexed.",
      }),
      opts(),
    );
    const result = await runWikiLint({ ...opts(), maxPatterns: 2 });
    // bbb duplicates aaa -> archived; then cap 2 archives the LRU overflow.
    expect(result.archivedDuplicates).toEqual(["bbb"]);
    expect(result.archivedOverflow).toHaveLength(1);
    expect(result.patternCountAfter).toBe(2);
    expect(result.orphans.length).toBeGreaterThanOrEqual(1);
    // Archived pages still exist under patterns/archive/ (append durability).
    const archived = await fs.readdir(path.join(tmpDir, "skill-wiki", "patterns", "archive"));
    expect(archived.length).toBe(2);
    // The archive subdir is never listed as a pattern.
    expect(await listPatternNames(opts())).not.toContain("archive");
  });

  it("is a no-op on a healthy wiki", async () => {
    await applyMaintainerOutput(
      out({
        createPatterns: [{ name: "p1", content: "x" }],
        updateIndex: "- [p1](patterns/p1.md): fine.",
      }),
      opts(),
    );
    const result = await runWikiLint(opts());
    expect(result).toMatchObject({
      archivedDuplicates: [],
      archivedOverflow: [],
      orphans: [],
      patternCountAfter: 1,
    });
  });
});

describe("P2P publish sweep", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "p2ppub-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("publishes only validated + matured + unpublished skills, with evidence attached", async () => {
    const now = Date.now();
    await writeEvolvedLiveSkill(tmpDir, "ready", {
      validation: { mode: "records", verdict: "accepted", validatedAt: now - 5 * DAY },
    });
    await writeEvolvedLiveSkill(tmpDir, "too-fresh", {
      validation: { mode: "records", verdict: "accepted", validatedAt: now - 1 * DAY },
    });
    await writeEvolvedLiveSkill(tmpDir, "already-out", {
      validation: { mode: "records", verdict: "accepted", validatedAt: now - 5 * DAY },
      published: { at: now - 4 * DAY },
    });
    await writeEvolvedLiveSkill(tmpDir, "never-validated", {});
    const eligible = await listP2pEligibleEvolvedSkills({ configDir: tmpDir, now });
    expect(eligible.map((e) => e.name)).toEqual(["ready"]);

    const calls: Array<{ name: string; content: string }> = [];
    const sweep = await publishEligibleEvolvedSkills({
      publisher: {
        publishSkill: async (b64, name) => {
          calls.push({ name, content: Buffer.from(b64, "base64").toString("utf-8") });
        },
      },
      storeOpts: { configDir: tmpDir },
      now,
    });
    expect(sweep.published).toEqual(["ready"]);
    expect(calls[0]?.content).toContain("wiki-evolution-provenance");
    expect(calls[0]?.content).toContain('"verdict":"accepted"');
    expect(calls[0]?.content).toContain("re-validate locally");
    // Publish-once marker written; second sweep publishes nothing.
    const again = await publishEligibleEvolvedSkills({
      publisher: {
        publishSkill: async () => {
          throw new Error("should not be called");
        },
      },
      storeOpts: { configDir: tmpDir },
      now,
    });
    expect(again.eligible).toBe(0);
    const trail = await readProvenance({ configDir: tmpDir });
    expect(trail.at(-1)).toMatchObject({ action: "p2p-publish", skillName: "ready" });
  });

  it("does not write the published marker when the bridge rejects the envelope", async () => {
    const now = Date.now();
    await writeEvolvedLiveSkill(tmpDir, "ready", {
      validation: { mode: "records", verdict: "accepted", validatedAt: now - 5 * DAY },
    });
    const sweep = await publishEligibleEvolvedSkills({
      publisher: {
        publishSkill: async () => {
          throw new Error("mesh unavailable");
        },
      },
      storeOpts: { configDir: tmpDir },
      now,
    });
    expect(sweep.published).toHaveLength(0);
    expect(sweep.failed[0]).toMatchObject({ name: "ready" });
    // Still eligible next sweep.
    expect(await listP2pEligibleEvolvedSkills({ configDir: tmpDir, now })).toHaveLength(1);
  });

  it("no-ops without a publisher (P2P down) while reporting eligibility", async () => {
    const now = Date.now();
    await writeEvolvedLiveSkill(tmpDir, "ready", {
      validation: { mode: "records", verdict: "accepted", validatedAt: now - 5 * DAY },
    });
    const sweep = await publishEligibleEvolvedSkills({
      publisher: null,
      storeOpts: { configDir: tmpDir },
      now,
    });
    expect(sweep).toMatchObject({ published: [], eligible: 1 });
  });
});

describe("collectEvolutionStatus", () => {
  it("summarizes wiki, sampler, evolved skills, eligibility and corpus from disk", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "status-"));
    try {
      const now = Date.now();
      await applyMaintainerOutput(
        out({ createPatterns: [{ name: "p1", content: "x" }], updateIndex: "- p1" }),
        { configDir: tmpDir },
      );
      await writeEvolvedLiveSkill(tmpDir, "ready", {
        validation: { mode: "records", verdict: "accepted", validatedAt: now - 5 * DAY },
      });
      const status = await collectEvolutionStatus({ configDir: tmpDir });
      expect(status.wiki).toMatchObject({ patternCount: 1, indexPresent: true });
      expect(status.evolvedLive).toEqual([
        expect.objectContaining({ name: "ready", verdict: "accepted", publishedAt: null }),
      ]);
      expect(status.p2pEligible).toEqual(["ready"]);
      expect(status.corpus.present).toBe(false);
      expect(status.stagedProposals).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
