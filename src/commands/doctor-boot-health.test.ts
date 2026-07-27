import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../terminal/note.js", () => ({ note: vi.fn() }));

import { armBootVerify, writeRollbackRecord } from "../infra/boot-verify.js";
import { noteBootHealth } from "./doctor-boot-health.js";
import { doctorFindings, resetDoctorOutcome } from "./doctor-outcome.js";

const NOW = 1_750_000_000_000;

describe("noteBootHealth", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-boothealth-"));
    prev = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = dir;
    resetDoctorOutcome();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const findings = () => doctorFindings().filter((f) => f.section === "Update Health");

  it("silent when there is nothing to report", () => {
    noteBootHealth(NOW);
    expect(findings()).toEqual([]);
  });

  it("errors on a stale beacon (boot never confirmed)", () => {
    armBootVerify({ prevSha: "good000", now: NOW - 60 * 60_000 });
    noteBootHealth(NOW);
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0]?.level).toBe("error");
    expect(f[0]?.message).toContain("git reset --hard good000");
  });

  it("warns persistently after a performed automatic rollback", () => {
    writeRollbackRecord({
      fromSha: "bad1112222333",
      toSha: "good000ffff",
      at: NOW - 10 * 60_000,
      detail: "reset to good000ffff; install ok; build ok; restart ok",
      ok: true,
    });
    noteBootHealth(NOW);
    const f = findings();
    expect(f).toHaveLength(1);
    expect(f[0]?.level).toBe("warn");
    expect(f[0]?.message).toContain("ROLLED BACK");
    expect(f[0]?.message).toContain("PRE-UPDATE code");
  });

  it("errors when the automatic rollback itself failed, with manual recovery", () => {
    writeRollbackRecord({
      fromSha: "bad111",
      toSha: "good000",
      at: NOW - 5 * 60_000,
      detail: "worktree has uncommitted changes — refusing to git reset",
      ok: false,
    });
    noteBootHealth(NOW);
    const f = findings();
    expect(f[0]?.level).toBe("error");
    expect(f[0]?.message).toContain("FAILED");
    expect(f[0]?.message).toContain("git reset --hard good000");
  });
});
