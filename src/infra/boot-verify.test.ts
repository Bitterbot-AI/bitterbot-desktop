import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armBootVerify,
  claimRollbackAttempt,
  clearRollbackRecord,
  confirmBootHealthy,
  DEFAULT_BOOT_VERIFY_DEADLINE_MS,
  disarmBootVerify,
  readBootVerify,
  readRollbackRecord,
  readStaleBootVerify,
  writeRollbackRecord,
} from "./boot-verify.js";

// resolveStateDir() honors BITTERBOT_STATE_DIR, so each test gets an isolated
// beacon location.

describe("boot-verify beacon", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-bootverify-"));
    prev = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("arms with a prevSha and a future deadline", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now, reason: "update.run" });
    const rec = readBootVerify();
    expect(rec?.prevSha).toBe("abc123");
    expect(rec?.armedAt).toBe(now);
    expect(rec?.deadlineAt).toBe(now + DEFAULT_BOOT_VERIFY_DEADLINE_MS);
  });

  it("is not stale before its deadline (boot may still be in progress)", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now });
    expect(readStaleBootVerify(now + 60_000)).toBeNull();
  });

  it("becomes stale once the deadline passes with no confirmation", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now });
    const stale = readStaleBootVerify(now + DEFAULT_BOOT_VERIFY_DEADLINE_MS + 1);
    expect(stale?.prevSha).toBe("abc123");
  });

  it("a healthy boot (confirm) clears the beacon so it never reads stale", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now });
    confirmBootHealthy();
    expect(readBootVerify()).toBeNull();
    expect(readStaleBootVerify(now + DEFAULT_BOOT_VERIFY_DEADLINE_MS + 1)).toBeNull();
  });

  it("confirm is a safe no-op when no beacon is armed", () => {
    expect(() => confirmBootHealthy()).not.toThrow();
    expect(readBootVerify()).toBeNull();
  });

  it("clamps a too-small deadline to a 60s floor", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: null, now, deadlineMs: 5 });
    expect(readBootVerify()?.deadlineAt).toBe(now + 60_000);
  });

  it("disarm removes a beacon whose restart never happened (no stale false-error)", () => {
    // The CLI update path arms before runDaemonRestart; when no daemon is
    // installed (restart returns false) the beacon must be disarmed, or it
    // goes stale 30 minutes later and error-blocks every subsequent update.
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now });
    disarmBootVerify();
    expect(readBootVerify()).toBeNull();
    expect(readStaleBootVerify(now + DEFAULT_BOOT_VERIFY_DEADLINE_MS + 1)).toBeNull();
  });

  it("rollback latch claims exactly once (a failed rollback must never repeat)", () => {
    const now = 1_000_000;
    armBootVerify({ prevSha: "abc123", now });
    const first = claimRollbackAttempt(now);
    expect(first?.prevSha).toBe("abc123");
    expect(readBootVerify()?.rollbackAttempted).toBe(true);
    // Second claim — same beacon — must refuse.
    expect(claimRollbackAttempt(now)).toBeNull();
  });

  it("rollback latch refuses a superseded beacon (a newer update owns the boot)", () => {
    armBootVerify({ prevSha: "abc123", now: 1_000_000 });
    armBootVerify({ prevSha: "def456", now: 2_000_000 }); // re-armed by a newer update
    expect(claimRollbackAttempt(1_000_000)).toBeNull();
    // The newer arming is still claimable by ITS watchdog.
    expect(claimRollbackAttempt(2_000_000)?.prevSha).toBe("def456");
  });

  it("rollback latch refuses when no beacon exists", () => {
    expect(claimRollbackAttempt(1_000_000)).toBeNull();
  });

  it("a healthy boot clears a FAILED rollback record (breaks the update-gate circle)", () => {
    // A failed rollback is error-level in doctor and blocks the update gate;
    // clearRollbackRecord() only runs inside a successful update. Without
    // this hook, a fully-recovered node would stay update-bricked forever.
    writeRollbackRecord({ fromSha: "bad", toSha: "good", at: 1, detail: "failed", ok: false });
    confirmBootHealthy();
    expect(readRollbackRecord()).toBeNull();
  });

  it("a healthy boot keeps a SUCCESSFUL rollback record (warn until next clean update)", () => {
    writeRollbackRecord({ fromSha: "bad", toSha: "good", at: 1, detail: "done", ok: true });
    confirmBootHealthy();
    expect(readRollbackRecord()?.ok).toBe(true);
  });

  it("rollback record round-trips and clears", () => {
    expect(readRollbackRecord()).toBeNull();
    writeRollbackRecord({
      fromSha: "bad111",
      toSha: "good000",
      at: 1_000_000,
      detail: "reset to good000; install ok; build ok; restart ok",
      ok: true,
    });
    const rec = readRollbackRecord();
    expect(rec?.toSha).toBe("good000");
    expect(rec?.ok).toBe(true);
    clearRollbackRecord();
    expect(readRollbackRecord()).toBeNull();
  });
});
