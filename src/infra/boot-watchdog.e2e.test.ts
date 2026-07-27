import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { readBootVerify, readRollbackRecord } from "./boot-verify.js";
import { runBootWatchdog } from "./boot-watchdog.js";

// End-to-end watchdog exercise against a REAL throwaway git repo: real
// resets, real beacon/latch/record file IO. Only pnpm/restart invocations
// are stubbed to success (a temp repo has nothing to build).

const T = 1_700_000_000_000;

async function git(root: string, ...args: string[]): Promise<string> {
  const res = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 30_000 });
  expect(res.code, `git ${args.join(" ")}: ${res.stderr}`).toBe(0);
  return res.stdout.trim();
}

const stubbedRunner = async (argv: string[], opts: { timeoutMs: number; cwd?: string }) => {
  if (argv[0] === "git") {
    const res = await runCommandWithTimeout(argv, opts);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code ?? 1 };
  }
  // pnpm install / pnpm build / gateway restart: succeed without doing work.
  return { stdout: "", stderr: "", code: 0 };
};

describe("boot-watchdog end-to-end (real git repo)", () => {
  let repo: string;
  let stateDir: string;
  let prevState: string | undefined;
  let shaA = "";
  let shaB = "";

  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-watchdog-repo-"));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-watchdog-state-"));
    prevState = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;

    await git(repo, "init", "-q");
    await git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--allow-empty",
      "-qm",
      "seed",
    );
    fs.writeFileSync(path.join(repo, "file.txt"), "v1\n");
    await git(repo, "add", "file.txt");
    await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "v1");
    shaA = await git(repo, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "file.txt"), "v2\n");
    await git(repo, "add", "file.txt");
    await git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "v2 (bad build)");
    shaB = await git(repo, "rev-parse", "HEAD");
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prevState;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function armExpiredBeacon(): void {
    fs.writeFileSync(
      path.join(stateDir, "boot-verify.json"),
      JSON.stringify({
        prevSha: shaA,
        armedAt: T,
        // Deadline (plus the watchdog's 60s grace) already long past.
        deadlineAt: Date.now() - 10 * 60_000,
        reason: "e2e",
      }),
      "utf-8",
    );
  }

  it("rolls the repo back to prevSha, latches, and records the outcome", async () => {
    armExpiredBeacon();

    await runBootWatchdog({ root: repo, expectedArmedAt: T, runCommand: stubbedRunner });

    // Real reset happened: HEAD is back on the pre-update sha, file restored.
    expect(await git(repo, "rev-parse", "HEAD")).toBe(shaA);
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf-8")).toBe("v1\n");

    // Latch persisted (a second watchdog run must refuse)...
    expect(readBootVerify()?.rollbackAttempted).toBe(true);
    // ...and the record names both shas for doctor.
    const record = readRollbackRecord();
    expect(record?.ok).toBe(true);
    expect(record?.fromSha).toBe(shaB);
    expect(record?.toSha).toBe(shaA);

    // Second invocation is a no-op (once-only).
    await runBootWatchdog({ root: repo, expectedArmedAt: T, runCommand: stubbedRunner });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(shaA);
  }, 60_000);

  it("refuses to reset a dirty worktree and records the failure", async () => {
    armExpiredBeacon();
    fs.writeFileSync(path.join(repo, "file.txt"), "uncommitted work\n");

    await runBootWatchdog({ root: repo, expectedArmedAt: T, runCommand: stubbedRunner });

    // Nothing was destroyed.
    expect(await git(repo, "rev-parse", "HEAD")).toBe(shaB);
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf-8")).toBe("uncommitted work\n");
    const record = readRollbackRecord();
    expect(record?.ok).toBe(false);
    expect(record?.detail).toContain("uncommitted changes");
    // Latch still set: no retry loop against a dirty tree either.
    expect(readBootVerify()?.rollbackAttempted).toBe(true);
  }, 60_000);

  it("exits without touching anything when the beacon was cleared (healthy boot)", async () => {
    // No beacon at all — the gateway bound and deleted it.
    await runBootWatchdog({ root: repo, expectedArmedAt: T, runCommand: stubbedRunner });
    expect(await git(repo, "rev-parse", "HEAD")).toBe(shaB);
    expect(readRollbackRecord()).toBeNull();
  }, 30_000);
});
