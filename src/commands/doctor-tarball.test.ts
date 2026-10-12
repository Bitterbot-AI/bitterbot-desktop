import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/note.js", () => ({ note: vi.fn() }));

import { readVersionLink, swapVersionLink } from "../infra/tarball-install.js";
import { writeVersionDir } from "../test-utils/fake-tarball-release.js";
import { runTarballInstallChecks } from "./doctor-tarball.js";

const PLATFORM = "linux-x64";

// Symlinks need privileges on Windows; tarball installs are Linux/macOS only.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix("doctor checks for a release-tarball install", () => {
  let home: string;
  let appDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-doctor-tarball-"));
    appDir = path.join(home, ".bitterbot", "app");
    writeVersionDir(path.join(appDir, "1.4.0"), "1.4.0", PLATFORM);
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(repair: boolean, deep = false) {
    return runTarballInstallChecks({
      installKind: "tarball",
      root: path.join(appDir, "1.4.0"),
      repair,
      deep,
      homedir: home,
      env: {},
      stateDir: path.join(home, ".bitterbot"),
    });
  }

  it("does nothing for other install kinds", async () => {
    expect(
      await runTarballInstallChecks({
        installKind: "git",
        root: "/repo",
        repair: true,
        deep: false,
      }),
    ).toEqual([]);
  });

  it("reports a missing current link and command link; --fix repairs both", async () => {
    const before = await run(false);
    const text = before.map((r) => `${r.level}: ${r.message}`).join("\n");
    expect(text).toContain("warn: current is missing");
    expect(text).toMatch(/\.local\/bin\/bitterbot is missing/);
    expect(readVersionLink(appDir, "current")).toBeNull();

    const after = await run(true);
    expect(after.filter((r) => r.level === "warn" || r.level === "error")).toEqual([]);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
    expect(fs.readlinkSync(path.join(home, ".local", "bin", "bitterbot"))).toBe(
      path.join(fs.realpathSync(appDir), "current", "bin", "bitterbot"),
    );
  });

  it("repairs a current link that points at a deleted version", async () => {
    swapVersionLink(appDir, "current", "1.3.0");
    await run(true);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
  });

  it("removes a dangling previous link on --fix", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    swapVersionLink(appDir, "previous", "1.2.0");
    const preview = await run(false);
    expect(preview.some((r) => r.message.includes("previous points at a missing version"))).toBe(
      true,
    );
    await run(true);
    expect(fs.existsSync(path.join(appDir, "previous"))).toBe(false);
  });

  it("leaves a command link that belongs to another install alone", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    const other = path.join(home, "other-bitterbot");
    fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    fs.symlinkSync(other, path.join(home, ".local", "bin", "bitterbot"));
    const results = await run(true);
    expect(results.some((r) => r.message.includes("another install; left alone"))).toBe(true);
    expect(fs.readlinkSync(path.join(home, ".local", "bin", "bitterbot"))).toBe(other);
  });

  it("names the reinstall command for a version directory that fails its manifest", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    fs.appendFileSync(path.join(appDir, "1.4.0", "dist", "entry.js"), "x");
    const quick = await run(false);
    const msg = quick.find((r) => r.message.includes("does not match its manifest"));
    expect(msg?.message).toContain("bitterbot update --reinstall");
    expect(msg?.message).toContain("dist/entry.js");
  });

  it("--deep hashes every file (same size, different content)", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    const file = path.join(appDir, "1.4.0", "dist", "entry.js");
    const body = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, body.replace("1.4.0", "9.9.9"));
    expect((await run(false)).some((r) => r.message.includes("does not match"))).toBe(false);
    expect((await run(false, true)).some((r) => r.message.includes("sha256 mismatch"))).toBe(true);
  });
});
