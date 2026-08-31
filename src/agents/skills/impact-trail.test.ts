import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendImpactEntry,
  impactTrailPath,
  provenancePath,
  readProvenance,
  resolveWikiDir,
} from "./impact-trail.js";

describe("impact-trail", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "impact-trail-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates the wiki dir and writes markdown + jsonl mirror", async () => {
    const ok = await appendImpactEntry(
      {
        source: "crystallize",
        action: "create",
        skillName: "test-skill",
        verdict: "accepted",
        detail: "reward 0.9",
        timestamp: 1700000000000,
      },
      { configDir: tmpDir },
    );
    expect(ok).toBe(true);
    const md = await fs.readFile(impactTrailPath({ configDir: tmpDir }), "utf-8");
    expect(md).toContain("# Skill Impact Trail");
    expect(md).toContain("[crystallize] action=create skill=`test-skill` verdict=accepted");
    expect(md).toContain("reward 0.9");
    const records = await readProvenance({ configDir: tmpDir });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ts: 1700000000000,
      source: "crystallize",
      action: "create",
      skillName: "test-skill",
      verdict: "accepted",
    });
  });

  it("appends — never rewrites — and keeps entries in order", async () => {
    await appendImpactEntry(
      { source: "guards", action: "promote", skillName: "a", verdict: "gate-failed" },
      { configDir: tmpDir },
    );
    await appendImpactEntry(
      { source: "guards", action: "promote", skillName: "a", verdict: "accepted" },
      { configDir: tmpDir },
    );
    const md = await fs.readFile(impactTrailPath({ configDir: tmpDir }), "utf-8");
    const failedIdx = md.indexOf("verdict=gate-failed");
    const acceptedIdx = md.indexOf("verdict=accepted");
    expect(failedIdx).toBeGreaterThan(-1);
    expect(acceptedIdx).toBeGreaterThan(failedIdx);
    expect(await readProvenance({ configDir: tmpDir })).toHaveLength(2);
  });

  it("caps embedded diffs so one entry cannot blow the file", async () => {
    const hugeDiff = "x".repeat(50_000);
    await appendImpactEntry(
      {
        source: "evolution",
        action: "create",
        skillName: "big",
        verdict: "rejected",
        diff: hugeDiff,
      },
      { configDir: tmpDir },
    );
    const md = await fs.readFile(impactTrailPath({ configDir: tmpDir }), "utf-8");
    expect(md.length).toBeLessThan(20_000);
    expect(md).toContain("[truncated");
    const records = await readProvenance({ configDir: tmpDir });
    expect(records[0]?.diffChars).toBe(50_000);
  });

  it("rolls an oversized trail aside instead of truncating history", async () => {
    const mdPath = impactTrailPath({ configDir: tmpDir });
    await fs.mkdir(resolveWikiDir({ configDir: tmpDir }), { recursive: true });
    await fs.writeFile(mdPath, "#old\n" + "y".repeat(2 * 1024 * 1024), "utf-8");
    await appendImpactEntry(
      { source: "editor", action: "create", skillName: "n", verdict: "ungated-human-edit" },
      { configDir: tmpDir },
    );
    const entries = await fs.readdir(resolveWikiDir({ configDir: tmpDir }));
    const rolled = entries.filter((e) => e.includes(".rolled"));
    expect(rolled).toHaveLength(1);
    const fresh = await fs.readFile(mdPath, "utf-8");
    expect(fresh).toContain("# Skill Impact Trail");
    expect(fresh).toContain("verdict=ungated-human-edit");
    expect(fresh.length).toBeLessThan(10_000);
  });

  it("swallows write failures rather than breaking the mutation path", async () => {
    // Point configDir at a path that cannot be a directory (a file).
    const fileAsDir = path.join(tmpDir, "not-a-dir");
    await fs.writeFile(fileAsDir, "block", "utf-8");
    const ok = await appendImpactEntry(
      { source: "editor", action: "create", skillName: "n", verdict: "ungated-human-edit" },
      { configDir: path.join(fileAsDir, "nested") },
    );
    expect(ok).toBe(false);
  });
});
