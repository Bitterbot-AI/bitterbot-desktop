/**
 * Release-tarball policy (PLAN-56 Phase 3a): the pure helpers shared by
 * scripts/build-release-tarball.mjs and the release workflow, plus the
 * cross-file invariants that keep the build, the installer and the gateway's
 * install-kind detection naming the same platforms and marker.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildManifest,
  INSTALL_KIND_MARKER,
  LAUNCHER_SCRIPT,
  nodeArchiveName,
  parseShasums,
  pickBundledNodeVersion,
  platformIdFor,
  RELEASE_PLATFORMS,
  renderChecksums,
  tarballBaseName,
  trustedCommentFor,
} from "../../scripts/release-tarball-lib.mjs";
import { TARBALL_INSTALL_MARKER, tarballAssetName, tarballPlatformId } from "./install-kind.js";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

describe("release-tarball naming", () => {
  it("names the top directory and asset bitterbot-<version>-<platform>", () => {
    expect(tarballBaseName("1.5.0", "linux-x64")).toBe("bitterbot-1.5.0-linux-x64");
    expect(`${tarballBaseName("1.5.0", "darwin-arm64")}.tar.gz`).toBe(
      tarballAssetName("1.5.0", "darwin-arm64"),
    );
    expect(() => tarballBaseName("1.5", "linux-x64")).toThrow();
    expect(`${tarballBaseName("1.6.2", "darwin-x64")}.tar.gz`).toBe(
      tarballAssetName("1.6.2", "darwin-x64"),
    );
    expect(() => tarballBaseName("1.5.0", "win32-x64")).toThrow(/no release tarball/);
  });

  it("builds exactly the platforms the gateway and install.sh know", () => {
    const ids = Object.keys(RELEASE_PLATFORMS).toSorted();
    expect(ids).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
    for (const id of ids) {
      const p = RELEASE_PLATFORMS[id as keyof typeof RELEASE_PLATFORMS];
      expect(platformIdFor(p.os, p.arch)).toBe(id);
      expect(tarballPlatformId(p.os, p.arch)).toBe(id);
    }
    expect(platformIdFor("win32", "x64")).toBeNull();
    expect(tarballPlatformId("win32", "x64")).toBeNull();
    const installSh = fs.readFileSync(repoFile("scripts/install.sh"), "utf8");
    expect(installSh).toContain("linux-x64 | linux-arm64 | darwin-arm64 | darwin-x64)");
    // The release workflow builds and requires every platform.
    const workflow = fs.readFileSync(repoFile(".github/workflows/release-tarball.yml"), "utf8");
    for (const id of ids) {
      expect(workflow).toContain(`platform: ${id}`);
    }
    expect(workflow).toContain("runner: macos-15-intel");
    // darwin-x64 is optional: its failure does not block a release, and the
    // publish job requires only the core platforms.
    const optional = ids.filter(
      (id) => RELEASE_PLATFORMS[id as keyof typeof RELEASE_PLATFORMS].optional,
    );
    expect(optional).toEqual(["darwin-x64"]);
    expect(workflow).toContain("continue-on-error: ${{ matrix.optional == true }}");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("filter(([, p]) => !p.optional)");
    const npmPublish = fs.readFileSync(repoFile(".github/workflows/npm-publish.yml"), "utf8");
    expect(npmPublish).toContain("filter(([, p]) => !p.optional)");
  });

  it("uses the marker file the install-kind detection reads", () => {
    expect(INSTALL_KIND_MARKER).toBe(TARBALL_INSTALL_MARKER);
  });

  it("signs with the `<tag> checksums` trusted comment install.sh requires", () => {
    expect(trustedCommentFor("1.5.0")).toBe("v1.5.0 checksums");
    const installSh = fs.readFileSync(repoFile("scripts/install.sh"), "utf8");
    expect(installSh).toContain('expected_comment="v${version} checksums"');
  });
});

describe("checksums", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);

  it("renders sha256sum format sorted by name and parses it back", () => {
    const text = renderChecksums([
      { name: "bitterbot-1.5.0-linux-x64.tar.gz", sha256: b },
      { name: "bitterbot-1.5.0-darwin-arm64.tar.gz", sha256: a },
    ]);
    expect(text).toBe(
      `${a}  bitterbot-1.5.0-darwin-arm64.tar.gz\n${b}  bitterbot-1.5.0-linux-x64.tar.gz\n`,
    );
    expect(parseShasums(text, "bitterbot-1.5.0-linux-x64.tar.gz")).toBe(b);
    expect(
      parseShasums(`${a} *node-v22.20.0-linux-x64.tar.gz\n`, "node-v22.20.0-linux-x64.tar.gz"),
    ).toBe(a);
    expect(parseShasums(text, "missing.tar.gz")).toBeNull();
  });

  it("refuses entries that are not bare names or real hashes", () => {
    expect(() => renderChecksums([{ name: "../x", sha256: a }])).toThrow();
    expect(() => renderChecksums([{ name: "x", sha256: "nope" }])).toThrow();
  });
});

describe("bundled Node", () => {
  const index = [
    { version: "v24.1.0", lts: "Krypton", files: ["linux-x64", "osx-arm64-tar"] },
    { version: "v22.21.0", lts: "Jod", files: ["linux-x64", "linux-arm64"] },
    { version: "v22.20.0", lts: "Jod", files: ["linux-x64", "linux-arm64", "osx-arm64-tar"] },
    { version: "v22.12.0", lts: "Jod", files: ["linux-x64", "osx-arm64-tar"] },
    { version: "v23.0.0", lts: false, files: ["linux-x64"] },
  ];

  it("picks the newest Node 22 LTS that ships this platform's tarball", () => {
    expect(pickBundledNodeVersion(index, "linux-x64")).toBe("v22.21.0");
    expect(pickBundledNodeVersion(index, "darwin-arm64")).toBe("v22.20.0");
    expect(pickBundledNodeVersion([index[3]], "linux-x64")).toBeNull(); // below 22.13
    expect(pickBundledNodeVersion("junk", "linux-x64")).toBeNull();
    expect(nodeArchiveName("v22.20.0", "darwin-arm64")).toBe("node-v22.20.0-darwin-arm64.tar.gz");
  });
});

describe("manifest", () => {
  it("records version, platform, runtimes and per-file hashes, sorted", () => {
    const m = buildManifest({
      version: "1.5.0",
      platformId: "linux-x64",
      nodeVersion: "v22.20.0",
      orchestratorVersion: "0.2.3",
      commit: "abc",
      builtAt: "2026-10-11T00:00:00.000Z",
      files: [
        { path: "dist/entry.js", sha256: "c".repeat(64), size: 1, mode: "644" },
        { path: "bin/bitterbot", sha256: "d".repeat(64), size: 2, mode: "755" },
        { path: "node_modules/x", link: ".pnpm/x/node_modules/x" },
      ],
    });
    expect(m).toMatchObject({
      schema: 1,
      kind: "release-tarball",
      version: "1.5.0",
      platform: "linux-x64",
      node: "v22.20.0",
      orchestrator: "0.2.3",
    });
    expect(m.files.map((f) => f.path)).toEqual([
      "bin/bitterbot",
      "dist/entry.js",
      "node_modules/x",
    ]);
    // install.sh greps these exact keys out of the pretty-printed manifest.
    const text = JSON.stringify(m, null, 1);
    expect(text).toContain('"version": "1.5.0"');
    expect(text).toContain('"platform": "linux-x64"');
  });
});

describe.skipIf(process.platform === "win32")("launcher (bin/bitterbot)", () => {
  it("resolves its symlinks, declares the install kind and execs the bundled Node", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-launcher-"));
    try {
      const install = path.join(root, "app", "1.5.0");
      fs.mkdirSync(path.join(install, "bin"), { recursive: true });
      fs.mkdirSync(path.join(install, "runtime", "node", "bin"), { recursive: true });
      fs.writeFileSync(path.join(install, "bin", "bitterbot"), LAUNCHER_SCRIPT, { mode: 0o755 });
      // A fake "node" that reports what the launcher handed it.
      fs.writeFileSync(
        path.join(install, "runtime", "node", "bin", "node"),
        '#!/bin/sh\necho "kind=$BITTERBOT_INSTALL_KIND root=$BITTERBOT_INSTALL_ROOT args=$*"\n',
        { mode: 0o755 },
      );
      fs.symlinkSync("1.5.0", path.join(root, "app", "current"));
      fs.mkdirSync(path.join(root, "bin"));
      const link = path.join(root, "bin", "bitterbot");
      fs.symlinkSync(path.join(root, "app", "current", "bin", "bitterbot"), link);
      const real = fs.realpathSync(install);
      const run = (env: Record<string, string>) =>
        spawnSync(link, ["--version"], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: root, ...env },
        }).stdout.trim();
      // Node's ExperimentalWarning (SQLite) is never shown to users.
      expect(run({})).toBe(
        `kind=tarball root=${real} args=--disable-warning=ExperimentalWarning ${real}/dist/entry.js --version`,
      );
      // The documented escape hatch survives the launcher.
      expect(run({ BITTERBOT_INSTALL_KIND: "package" })).toContain("kind=package");
      // PATH keeps the user's Node first and names exactly one bundled
      // runtime, this version's, however many restarts and updates it went
      // through (each relaunch inherits the previous launcher's PATH).
      fs.writeFileSync(
        path.join(install, "runtime", "node", "bin", "node"),
        '#!/bin/sh\necho "$PATH"\n',
        { mode: 0o755 },
      );
      const appReal = fs.realpathSync(path.join(root, "app"));
      const inherited = [
        "/usr/local/bin",
        `${appReal}/1.4.0/runtime/node/bin`,
        "/usr/bin",
        `${real}/runtime/node/bin`,
        `${appReal}/current/runtime/node/bin`,
        `${real}/runtime/node/bin`,
        "/bin",
      ].join(":");
      expect(run({ PATH: inherited })).toBe(
        `/usr/local/bin:/usr/bin:/bin:${real}/runtime/node/bin`,
      );
      const twice = spawnSync(link, [], {
        encoding: "utf8",
        env: { PATH: run({ PATH: inherited }), HOME: root },
      }).stdout.trim();
      expect(twice).toBe(`/usr/local/bin:/usr/bin:/bin:${real}/runtime/node/bin`);
      // Each launch leaves an in-use marker (its pid) in the version directory.
      expect(fs.readdirSync(path.join(install, ".pids")).length).toBeGreaterThan(0);
      expect(fs.readdirSync(path.join(install, ".pids")).every((n) => /^\d+$/.test(n))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release-tarball.yml publishing rules", () => {
  const wf = fs.readFileSync(repoFile(".github/workflows/release-tarball.yml"), "utf8");

  it("uploads tarballs, then checksums + signature, then install.sh", () => {
    const tarballs = wf.indexOf('gh release upload "v$VERSION" bitterbot-*.tar.gz');
    const checksums = wf.indexOf(
      'gh release upload "v$VERSION" checksums.txt checksums.txt.minisig',
    );
    const installer = wf.indexOf('gh release upload "v$VERSION" install.sh');
    expect(tarballs).toBeGreaterThan(0);
    expect(checksums).toBeGreaterThan(tarballs);
    expect(installer).toBeGreaterThan(checksums);
  });

  it("refuses a manual rebuild of a signed release unless forced", () => {
    expect(wf).toMatch(/force:\r?\n\s+description:/);
    expect(wf).toContain('if [ "$EVENT" = "workflow_dispatch" ] && [ "$FORCE" != "true" ]; then');
    expect(wf).toContain("grep -qx 'checksums.txt'");
  });

  it("builds reproducibly from the tag commit time", () => {
    expect(wf).toContain("SOURCE_DATE_EPOCH: ${{ needs.meta.outputs.epoch }}");
    expect(wf).toContain('echo "epoch=$(git log -1 --format=%ct)"');
  });

  it("SHA-pins every action and uses no dependency cache", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(4);
    for (const ref of uses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
    }
    expect(wf).not.toMatch(/cache:\s*pnpm/);
  });

  it("normalizes the concurrency key to the v-prefixed tag", () => {
    expect(wf).toContain("format('v{0}', inputs.version)");
  });
});
