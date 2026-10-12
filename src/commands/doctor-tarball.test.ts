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

  it("--fix removes a provably stale .update.lock and the leftovers it guarded", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    fs.mkdirSync(path.join(appDir, ".update-abc123"));
    // An owner that exited long ago (pid beyond any pid_max).
    fs.writeFileSync(
      path.join(appDir, ".update.lock"),
      JSON.stringify({ pid: 2 ** 22 + 12345, token: "t", createdAt: Date.now() }),
    );
    const preview = await run(false);
    expect(preview.some((r) => r.level === "warn" && r.message.includes("is stale"))).toBe(true);
    expect(preview.some((r) => r.message.includes("of an interrupted update"))).toBe(true);
    const fixed = await run(true);
    expect(fixed.some((r) => r.message.includes("Removed a stale .update.lock"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, ".update.lock"))).toBe(false);
    expect(fs.existsSync(path.join(appDir, ".update-abc123"))).toBe(false);
  });

  it("--fix leaves a held lock (and its update's files) alone", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    fs.mkdirSync(path.join(appDir, ".update-abc123"));
    fs.writeFileSync(
      path.join(appDir, ".update.lock"),
      JSON.stringify({ pid: process.pid, token: "t", createdAt: Date.now() }),
    );
    await run(true);
    expect(fs.existsSync(path.join(appDir, ".update.lock"))).toBe(true);
    expect(fs.existsSync(path.join(appDir, ".update-abc123"))).toBe(true);
  });

  it("lists files a rollback replaced, with sizes and how to delete them", async () => {
    swapVersionLink(appDir, "current", "1.4.0");
    const kept = path.join(
      home,
      ".bitterbot",
      "update-displaced",
      "20261011T000000Z-1.5.0-to-1.4.0",
    );
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(path.join(kept, "database-main.sqlite"), Buffer.alloc(2_500_000));
    const results = await run(true);
    const msg = results.find((r) => r.message.includes("replaced by a rollback"))?.message ?? "";
    expect(msg).toContain("20261011T000000Z-1.5.0-to-1.4.0 (2.5 MB)");
    expect(msg).toContain("rm -r");
    // Doctor never deletes them, even with --fix.
    expect(fs.existsSync(path.join(kept, "database-main.sqlite"))).toBe(true);
  });
});
