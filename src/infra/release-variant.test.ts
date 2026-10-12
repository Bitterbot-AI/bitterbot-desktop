/**
 * scripts/make-release-variant.mjs (the CI helper that derives version B and
 * a broken B' from the PR's tarball): the variant is a valid release whose
 * manifest matches every file, and --fail-gateway only breaks `gateway`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishFakeRelease } from "../test-utils/fake-tarball-release.js";
import { makeTestMinisignKey } from "../test-utils/minisign.js";
import { readTarballManifest, verifyVersionDir } from "./tarball-install.js";

const SCRIPT = fileURLToPath(new URL("../../scripts/make-release-variant.mjs", import.meta.url));
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("make-release-variant", () => {
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-variant-"));
    const releases = path.join(work, "releases");
    publishFakeRelease({
      releases,
      work,
      version: "1.4.0",
      platformId: "linux-x64",
      key: makeTestMinisignKey(),
    });
    // Like a real tarball: package.json and dist/build-info.json carry the version.
    const src = path.join(work, "src");
    fs.mkdirSync(src, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(releases, "download", "v1.4.0", "bitterbot-1.4.0-linux-x64.tar.gz"),
      "-C",
      src,
    ]);
    const top = path.join(src, "bitterbot-1.4.0-linux-x64");
    fs.writeFileSync(path.join(top, "package.json"), '{"name":"bitterbot","version":"1.4.0"}\n');
    fs.writeFileSync(path.join(top, "dist", "build-info.json"), '{"version":"1.4.0"}\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(top, "manifest.json"), "utf8")) as {
      files: Array<{ path: string; sha256?: string; size?: number }>;
    };
    manifest.files.push(
      { path: "package.json", sha256: "0".repeat(64), size: 0 },
      { path: "dist/build-info.json", sha256: "0".repeat(64), size: 0 },
    );
    fs.writeFileSync(path.join(top, "manifest.json"), JSON.stringify(manifest));
    execFileSync("tar", [
      "-czf",
      path.join(work, "a.tar.gz"),
      "-C",
      src,
      "bitterbot-1.4.0-linux-x64",
    ]);
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function variant(version: string, extra: string[] = []) {
    const out = path.join(work, `out-${version}`);
    execFileSync(process.execPath, [
      SCRIPT,
      "--tarball",
      path.join(work, "a.tar.gz"),
      "--version",
      version,
      "--out",
      out,
      ...extra,
    ]);
    const unpack = path.join(work, `unpack-${version}`);
    fs.mkdirSync(unpack);
    execFileSync("tar", [
      "-xzf",
      path.join(out, `bitterbot-${version}-linux-x64.tar.gz`),
      "-C",
      unpack,
    ]);
    return path.join(unpack, `bitterbot-${version}-linux-x64`);
  }

  it("bumps the version everywhere and keeps the manifest exact", async () => {
    const dir = variant("1.4.1");
    expect(readTarballManifest(dir)?.version).toBe("1.4.1");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe(
      "1.4.1",
    );
    expect((await verifyVersionDir(dir, { mode: "full" })).ok).toBe(true);
  });

  it("--fail-gateway breaks only the gateway command", async () => {
    const dir = variant("1.4.2", ["--fail-gateway"]);
    expect((await verifyVersionDir(dir, { mode: "full" })).ok).toBe(true);
    const launcher = path.join(dir, "bin", "bitterbot");
    expect(spawnSync(launcher, ["gateway"]).status).toBe(1);
    expect(spawnSync(launcher, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("1.4.0");
  });
});
