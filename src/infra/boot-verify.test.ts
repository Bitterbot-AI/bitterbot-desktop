import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  armBootVerify,
  confirmBootHealthy,
  DEFAULT_BOOT_VERIFY_DEADLINE_MS,
  readBootVerify,
  readStaleBootVerify,
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
});
