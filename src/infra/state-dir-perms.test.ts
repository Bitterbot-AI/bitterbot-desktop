import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isUnsafeStateDir,
  securePrivateStateDir,
  stateDirPermsNotice,
  targetStateDirMode,
} from "./state-dir-perms.js";

describe("targetStateDirMode", () => {
  it("default-umask modes become 0700; deliberate group sharing keeps its group bits", () => {
    expect(targetStateDirMode(0o755)).toBe(0o700);
    expect(targetStateDirMode(0o775)).toBe(0o700);
    expect(targetStateDirMode(0o777)).toBe(0o700);
    expect(targetStateDirMode(0o700)).toBeNull();
    expect(targetStateDirMode(0o750)).toBeNull();
    expect(targetStateDirMode(0o770)).toBeNull();
    expect(targetStateDirMode(0o2775)).toBe(0o2770);
    expect(targetStateDirMode(0o751)).toBe(0o750);
  });

  it("never home, / or a parent of home", () => {
    expect(isUnsafeStateDir("/home/u", "/home/u")).toBe(true);
    expect(isUnsafeStateDir("/", "/home/u")).toBe(true);
    expect(isUnsafeStateDir("/home", "/home/u")).toBe(true);
    expect(isUnsafeStateDir("/home/u/.bitterbot", "/home/u")).toBe(false);
    expect(isUnsafeStateDir("/home/user2", "/home/u")).toBe(false);
  });
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("securePrivateStateDir", () => {
  let work: string;
  const home = () => path.join(work, "home");
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-state-perms-"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });
  const run = (dir: string, extra: Partial<Parameters<typeof securePrivateStateDir>[0]> = {}) =>
    securePrivateStateDir({
      stateDir: dir,
      env: {},
      homedir: home(),
      inContainer: false,
      ...extra,
    });

  it("leaves a container's state dir alone (often a bind mount the host user reads)", () => {
    const dir = path.join(work, ".bitterbot");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect(run(dir, { inContainer: true })).toMatchObject({
      action: "skipped",
      reason: "container",
    });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("creates a missing state dir 0700", () => {
    const dir = path.join(work, "a", ".bitterbot");
    expect(run(dir).action).toBe("created");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens a 0755 dir, only the dir itself, with a notice; then leaves it alone", () => {
    const dir = path.join(work, ".bitterbot");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, "bitterbot.json"), "{}");
    fs.chmodSync(path.join(dir, "bitterbot.json"), 0o644);
    const first = run(dir);
    expect(first).toMatchObject({ action: "tightened", from: 0o755, to: 0o700 });
    expect(stateDirPermsNotice(first)).toContain("was 755");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "bitterbot.json")).mode & 0o777).toBe(0o644);
    expect(run(dir).action).toBe("ok");
  });

  it("keeps deliberate group access: 0751 loses only the world bit", () => {
    const dir = path.join(work, "shared");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o751);
    const res = run(dir);
    expect(res).toMatchObject({ action: "tightened", to: 0o750 });
    expect(stateDirPermsNotice(res)).toContain("group access is kept");
  });

  it("skips: another owner, Windows, the opt-out, home itself, and a filesystem that ignores chmod", () => {
    const dir = path.join(work, ".bitterbot");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    expect(run(dir, { getuid: () => 123456 })).toMatchObject({ reason: "not-owner" });
    expect(run(dir, { platform: "win32" })).toMatchObject({ reason: "windows" });
    expect(run(dir, { env: { BITTERBOT_STATE_DIR_PERMS: "keep" } })).toMatchObject({
      reason: "opted-out",
    });
    expect(run(home(), {})).toMatchObject({ reason: "unsafe-dir" });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    // drvfs/CIFS: chmod "succeeds" but nothing changes.
    const ignoring = run(dir, {
      fsImpl: {
        existsSync: fs.existsSync,
        mkdirSync: fs.mkdirSync,
        statSync: fs.statSync,
        chmodSync: () => {},
      },
    });
    expect(ignoring).toMatchObject({ action: "skipped", reason: "unsupported" });
    expect(stateDirPermsNotice(ignoring)).toBeNull();
  });
});
