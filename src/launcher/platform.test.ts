/**
 * Which release build the launcher installs, and the message every
 * unsupported machine gets instead (install.sh's bb_detect_platform rules).
 */
import { describe, expect, it } from "vitest";
import { detectLauncherPlatform, type PlatformProbe } from "./platform.js";

function probe(p: Partial<PlatformProbe>): PlatformProbe {
  return {
    platform: "linux",
    arch: "x64",
    glibcVersion: () => "2.35",
    isMusl: () => false,
    isRosetta: () => false,
    ...p,
  };
}

describe("detectLauncherPlatform", () => {
  it("maps supported machines to their tarball", () => {
    expect(detectLauncherPlatform(probe({}))).toEqual({ ok: true, platformId: "linux-x64" });
    expect(detectLauncherPlatform(probe({ arch: "arm64" }))).toEqual({
      ok: true,
      platformId: "linux-arm64",
    });
    expect(detectLauncherPlatform(probe({ platform: "darwin", arch: "arm64" }))).toEqual({
      ok: true,
      platformId: "darwin-arm64",
    });
    expect(detectLauncherPlatform(probe({ platform: "darwin", arch: "x64" }))).toEqual({
      ok: true,
      platformId: "darwin-x64",
    });
  });

  it("gives an x64 Node under Rosetta the native Apple silicon build", () => {
    expect(
      detectLauncherPlatform(probe({ platform: "darwin", arch: "x64", isRosetta: () => true })),
    ).toEqual({ ok: true, platformId: "darwin-arm64" });
  });

  it("sends Windows to WSL2 via install.ps1", () => {
    const r = detectLauncherPlatform(probe({ platform: "win32" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("WSL2");
      expect(r.message).toContain(
        "irm https://raw.githubusercontent.com/Bitterbot-AI/bitterbot-desktop/main/scripts/install.ps1 | iex",
      );
    }
  });

  it("sends musl, old glibc and other systems to Docker", () => {
    for (const p of [
      probe({ isMusl: () => true }),
      probe({ glibcVersion: () => "2.17" }),
      probe({ platform: "freebsd" }),
      probe({ arch: "ia32" }),
    ]) {
      const r = detectLauncherPlatform(p);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toMatch(/Use Docker: https:\/\/github\.com\/.*docker\.md$/);
        expect(r.message).not.toContain("\u2014");
      }
    }
  });

  it("accepts glibc 2.28 exactly and an unknown glibc", () => {
    expect(detectLauncherPlatform(probe({ glibcVersion: () => "2.28" })).ok).toBe(true);
    expect(detectLauncherPlatform(probe({ glibcVersion: () => null })).ok).toBe(true);
  });
});
