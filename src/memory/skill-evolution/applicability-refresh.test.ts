/**
 * PLAN-58 Phase B: the housekeeping refresh writes one `.applicability.json`
 * per governed or read live skill, skips the rest, and the on-disk file
 * parses back as a valid profile.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPLICABILITY_PROFILE_FILENAME } from "./applicability-profile.js";
import { readApplicabilityProfile, refreshApplicabilityProfiles } from "./applicability-refresh.js";
import type { SkillReadEvent } from "./skill-reads.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function ev(over: Partial<SkillReadEvent>): SkillReadEvent {
  return {
    runId: "r",
    skill: "acme",
    ts: NOW - DAY,
    success: true,
    label: "pass",
    outcomeLevel: 2,
    model: "anthropic/claude-opus-4-8",
    completedExplicitly: false,
    toolErrors: 0,
    origin: "human",
    sessionKey: "agent:main:main",
    credited: true,
    ...over,
  };
}

describe("refreshApplicabilityProfiles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "applicability-"));
    for (const name of ["acme", "beta", "bundled"]) {
      await fs.mkdir(path.join(dir, "skills", name), { recursive: true });
      await fs.writeFile(
        path.join(dir, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: d\nbitterbot:\n  requires:\n    bins: [jq]\n---\nbody\n`,
      );
    }
    await fs.writeFile(
      path.join(dir, "skills", "acme", ".evolution-meta.json"),
      JSON.stringify({
        origin: "wiki-evolution",
        validation: {
          mode: "tasks",
          verdict: "accepted",
          validatedAt: NOW - 2 * DAY,
          model: "anthropic/claude-opus-4-8",
          trials: 6,
          meanDelta: 0.1,
          ci95Low: 0.02,
        },
      }),
    );
    await fs.mkdir(path.join(dir, "skill-wiki"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "skill-wiki", "skill-reads.jsonl"),
      `${JSON.stringify(ev({ runId: "r1" }))}\n${JSON.stringify(ev({ runId: "r2", skill: "beta", label: "fail", success: false }))}\n`,
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a profile for governed or read skills and skips the rest; the file parses back", async () => {
    const result = await refreshApplicabilityProfiles({
      storeOpts: { configDir: dir },
      journal: null,
      platform: "linux",
      now: NOW,
    });
    expect(result).toEqual({ written: 2, skipped: 1 });
    const acme = await readApplicabilityProfile(path.join(dir, "skills"), "acme");
    expect(acme?.outcomes).toMatchObject({ runs: 1, pass: 1, fail: 0 });
    expect(acme?.outcomes.gate).toEqual({ trials: 6, meanDelta: 0.1, ci95Low: 0.02 });
    expect(acme?.declared.bins).toEqual(["jq"]);
    expect(acme?.measured.os).toEqual(["linux"]);
    // No journal: shape is empty, never a failure.
    expect(acme?.shape).toEqual({ tools: [], sequenceHashes: [] });
    const beta = await readApplicabilityProfile(path.join(dir, "skills"), "beta");
    expect(beta?.outcomes).toMatchObject({ runs: 1, pass: 0, fail: 1 });
    await expect(
      fs.access(path.join(dir, "skills", "bundled", APPLICABILITY_PROFILE_FILENAME)),
    ).rejects.toThrow();
  });

  it("returns zeros for a missing live root and null for an absent or corrupt profile", async () => {
    expect(
      await refreshApplicabilityProfiles({
        storeOpts: { configDir: path.join(dir, "nope") },
        journal: null,
        platform: "linux",
      }),
    ).toEqual({ written: 0, skipped: 0 });
    expect(await readApplicabilityProfile(path.join(dir, "skills"), "acme")).toBeNull();
    await fs.writeFile(
      path.join(dir, "skills", "acme", APPLICABILITY_PROFILE_FILENAME),
      "{not json",
    );
    expect(await readApplicabilityProfile(path.join(dir, "skills"), "acme")).toBeNull();
  });
});
