import { describe, expect, it } from "vitest";
import { resolveEffectiveUpdateChannel } from "./update-channels.js";

describe("resolveEffectiveUpdateChannel: default channel by install kind (PLAN-56 §3.5)", () => {
  it("package and container installs default to stable", () => {
    expect(resolveEffectiveUpdateChannel({ installKind: "package" })).toEqual({
      channel: "stable",
      source: "default",
    });
    expect(resolveEffectiveUpdateChannel({ installKind: "container" })).toEqual({
      channel: "stable",
      source: "default",
    });
  });

  it("a git checkout on a release tag follows stable (beta for a beta tag)", () => {
    expect(
      resolveEffectiveUpdateChannel({ installKind: "git", git: { tag: "v1.4.0", branch: "HEAD" } }),
    ).toEqual({ channel: "stable", source: "git-tag" });
    expect(
      resolveEffectiveUpdateChannel({
        installKind: "git",
        git: { tag: "v1.5.0-beta.1", branch: "HEAD" },
      }),
    ).toEqual({ channel: "beta", source: "git-tag" });
  });

  it("only a git checkout on a branch with no configured channel defaults to dev", () => {
    expect(
      resolveEffectiveUpdateChannel({ installKind: "git", git: { tag: null, branch: "main" } }),
    ).toEqual({ channel: "dev", source: "git-branch" });
  });

  it("main whose tip carries a release tag stays dev (never jumps to a detached tag)", () => {
    expect(
      resolveEffectiveUpdateChannel({ installKind: "git", git: { tag: "v1.4.0", branch: "main" } }),
    ).toEqual({ channel: "dev", source: "git-branch" });
  });

  it("a configured channel always wins", () => {
    for (const installKind of ["git", "package", "container", "unknown"] as const) {
      expect(
        resolveEffectiveUpdateChannel({
          configChannel: "beta",
          installKind,
          git: { tag: null, branch: "main" },
        }),
      ).toEqual({ channel: "beta", source: "config" });
    }
  });
});
