/**
 * PLAN-43 Phase 0: the sqlite⇄fs join that lets marketplace ranking read
 * PLAN-42 validation verdicts off the live skill dirs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizeSkillName, readValidationSummaries } from "./validation-summaries.js";

let configDir: string;

async function writeLiveSkill(name: string, meta: unknown): Promise<void> {
  const dir = path.join(configDir, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  if (meta !== undefined) {
    await fs.writeFile(path.join(dir, ".evolution-meta.json"), JSON.stringify(meta), "utf-8");
  }
}

describe("readValidationSummaries", () => {
  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "validation-summaries-"));
  });

  it("returns summaries for validated evolved skills, keyed by normalized name", async () => {
    await writeLiveSkill("wiki-helper", {
      origin: "wiki-evolution",
      validation: {
        mode: "tasks",
        verdict: "accepted",
        meanDelta: 0.25,
        ci95Low: 0.05,
        corpusVersion: "canonical-abc123+def456",
        validatedAt: 1234,
      },
    });
    await writeLiveSkill("hand-written", undefined); // no meta: not evolved
    await writeLiveSkill("unvalidated", { origin: "wiki-evolution" }); // no verdict yet
    await writeLiveSkill("foreign-origin", {
      origin: "manual",
      validation: { mode: "tasks", verdict: "accepted", validatedAt: 1 },
    });

    const summaries = readValidationSummaries({ configDir });

    expect(summaries.size).toBe(1);
    const s = summaries.get("wiki-helper");
    expect(s).toMatchObject({
      skillName: "wiki-helper",
      verdict: "accepted",
      meanDelta: 0.25,
      canonical: true,
    });
  });

  it("flags canonical only for canonical-corpus verdicts", async () => {
    await writeLiveSkill("grown-only", {
      origin: "wiki-evolution",
      validation: {
        mode: "tasks",
        verdict: "accepted",
        corpusVersion: "def456",
        validatedAt: 1,
      },
    });
    const summaries = readValidationSummaries({ configDir });
    expect(summaries.get("grown-only")!.canonical).toBe(false);
  });

  it("missing live root yields an empty map, never a throw", () => {
    expect(readValidationSummaries({ configDir: path.join(configDir, "nope") }).size).toBe(0);
  });

  it("drops BOTH skills when two dirs collide post-normalization (no mis-attribution)", async () => {
    const meta = {
      origin: "wiki-evolution",
      validation: { mode: "tasks", verdict: "accepted", validatedAt: 1 },
    };
    await writeLiveSkill("my-skill", meta);
    await writeLiveSkill("my.skill", meta); // also normalizes to "my-skill"
    const summaries = readValidationSummaries({ configDir });
    expect(summaries.has("my-skill")).toBe(false);
    expect(summaries.size).toBe(0);
  });
});

describe("normalizeSkillName", () => {
  it("joins crystal-listing names to skill-dir slugs", () => {
    expect(normalizeSkillName("# Wiki Helper")).toBe("wiki-helper");
    expect(normalizeSkillName("wiki-helper")).toBe("wiki-helper");
    expect(normalizeSkillName("  Wiki   Helper!  ")).toBe("wiki-helper");
  });
});
