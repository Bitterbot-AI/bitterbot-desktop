import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { securePrivateStateDir, stateDirPermsNotice } from "./state-dir-perms.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("securePrivateStateDir", () => {
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-state-perms-"));
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("creates a missing state dir 0700", () => {
    const dir = path.join(work, "a", ".bitterbot");
    expect(securePrivateStateDir({ stateDir: dir }).action).toBe("created");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("tightens an existing 0755 dir once, only the dir itself, with a notice", () => {
    const dir = path.join(work, ".bitterbot");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, "bitterbot.json"), "{}", { mode: 0o644 });
    fs.chmodSync(path.join(dir, "bitterbot.json"), 0o644);
    const first = securePrivateStateDir({ stateDir: dir });
    expect(first).toMatchObject({ action: "tightened", from: 0o755 });
    expect(stateDirPermsNotice(first)).toContain("was 755");
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // Data files are never touched.
    expect(fs.statSync(path.join(dir, "bitterbot.json")).mode & 0o777).toBe(0o644);
    const again = securePrivateStateDir({ stateDir: dir });
    expect(again.action).toBe("ok");
    expect(stateDirPermsNotice(again)).toBeNull();
  });

  it("leaves a dir owned by another user (a mounted volume) and Windows alone", () => {
    const dir = path.join(work, ".bitterbot");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o755);
    const other = securePrivateStateDir({ stateDir: dir, getuid: () => 123456 });
    expect(other).toMatchObject({ action: "skipped", reason: "not-owner" });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
    expect(securePrivateStateDir({ stateDir: dir, platform: "win32" }).action).toBe("skipped");
  });
});
