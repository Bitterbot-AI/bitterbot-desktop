import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "./update-check.js";
import { VERSION } from "../version.js";
import { computeUpdateStaleness, DEFAULT_PROMPT_BEHIND_COMMITS } from "./update-staleness.js";

function gitCheck(behind: number | null): UpdateCheckResult {
  return {
    root: "/repo",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/repo",
      sha: "abc123",
      tag: null,
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind,
      fetchOk: true,
    },
  };
}

describe("computeUpdateStaleness", () => {
  it("is fresh below the default threshold and stale at it", () => {
    expect(computeUpdateStaleness(gitCheck(DEFAULT_PROMPT_BEHIND_COMMITS - 1))).toMatchObject({
      stale: false,
      reason: "fresh",
      behind: DEFAULT_PROMPT_BEHIND_COMMITS - 1,
    });
    expect(computeUpdateStaleness(gitCheck(DEFAULT_PROMPT_BEHIND_COMMITS))).toMatchObject({
      stale: true,
      reason: "git-behind",
    });
  });

  it("honors a configured threshold", () => {
    expect(computeUpdateStaleness(gitCheck(5), 5)).toMatchObject({ stale: true, threshold: 5 });
    expect(computeUpdateStaleness(gitCheck(4), 5)).toMatchObject({ stale: false });
  });

  it("never prompts on unknown behind counts", () => {
    expect(computeUpdateStaleness(gitCheck(null))).toMatchObject({
      stale: false,
      reason: "unknown",
      behind: null,
    });
  });

  it("falls back to the default on nonsense thresholds", () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = computeUpdateStaleness(gitCheck(1), bad);
      expect(verdict.threshold).toBe(DEFAULT_PROMPT_BEHIND_COMMITS);
      expect(verdict.stale).toBe(false);
    }
  });

  // Fixture note: "newer" versions must keep major < 2000 — the D-A CalVer
  // guard deliberately sorts date-shaped majors (>= 2000) BEFORE any real
  // SemVer, so 9999.0.0 would read as an OLD CalVer, not a future release.
  it("package installs go stale on a newer registry version", () => {
    const base: UpdateCheckResult = {
      root: "/opt/bitterbot",
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "999.0.0" },
    };
    expect(computeUpdateStaleness(base)).toMatchObject({
      stale: true,
      reason: "package-version",
    });
    expect(computeUpdateStaleness({ ...base, registry: { latestVersion: VERSION } })).toMatchObject(
      { stale: false, reason: "fresh" },
    );
    expect(computeUpdateStaleness({ ...base, registry: { latestVersion: null } })).toMatchObject({
      stale: false,
      reason: "unknown",
    });
  });

  it("package installs prefer the channel version over registry latest", () => {
    const base: UpdateCheckResult = {
      root: "/opt/bitterbot",
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "999.0.0" },
    };
    // Channel tag matches the running version: latest being newer is irrelevant.
    expect(computeUpdateStaleness(base, undefined, { channelVersion: VERSION })).toMatchObject({
      stale: false,
      reason: "fresh",
    });
    // Channel tag is ahead: stale even if registry latest were missing.
    expect(
      computeUpdateStaleness({ ...base, registry: undefined }, undefined, {
        channelVersion: "999.0.0",
      }),
    ).toMatchObject({ stale: true, reason: "package-version" });
  });

  it("unknown installs never prompt", () => {
    expect(
      computeUpdateStaleness({ root: null, installKind: "unknown", packageManager: "unknown" }),
    ).toMatchObject({ stale: false, reason: "unknown" });
  });
});
