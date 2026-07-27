import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4242, unref: vi.fn(), on: vi.fn() })));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock, default: { ...actual, spawn: spawnMock } };
});

import { armBootVerify } from "./boot-verify.js";
import { decideWatchdogAction, performRollback, spawnBootWatchdog } from "./boot-watchdog.js";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

function beacon(overrides: Partial<Parameters<typeof decideWatchdogAction>[0]["beacon"] & object>) {
  return {
    prevSha: "good000",
    armedAt: NOW,
    deadlineAt: NOW + 30 * MIN,
    ...overrides,
  };
}

describe("decideWatchdogAction", () => {
  it("exits healthy the moment the beacon clears (the common path)", () => {
    expect(decideWatchdogAction({ beacon: null, expectedArmedAt: NOW, now: NOW + MIN })).toBe(
      "exit-healthy",
    );
  });

  it("stands down when a newer update re-armed the beacon", () => {
    expect(
      decideWatchdogAction({
        beacon: beacon({ armedAt: NOW + 5 * MIN }),
        expectedArmedAt: NOW,
        now: NOW + 40 * MIN,
      }),
    ).toBe("exit-superseded");
  });

  it("stands down when a rollback was already attempted (once-only)", () => {
    expect(
      decideWatchdogAction({
        beacon: beacon({ rollbackAttempted: true }),
        expectedArmedAt: NOW,
        now: NOW + 60 * MIN,
      }),
    ).toBe("exit-already-attempted");
  });

  it("waits while the deadline (plus grace) has not passed", () => {
    expect(
      decideWatchdogAction({ beacon: beacon({}), expectedArmedAt: NOW, now: NOW + 29 * MIN }),
    ).toBe("wait");
    // Deadline passed but inside the grace beat — still wait.
    expect(
      decideWatchdogAction({
        beacon: beacon({}),
        expectedArmedAt: NOW,
        now: NOW + 30 * MIN + 30_000,
      }),
    ).toBe("wait");
  });

  it("rolls back once the deadline plus grace has passed", () => {
    expect(
      decideWatchdogAction({
        beacon: beacon({}),
        expectedArmedAt: NOW,
        now: NOW + 31 * MIN + 1,
      }),
    ).toBe("rollback");
  });
});

type Call = { argv: string[] };

function runner(responses: Record<string, { stdout?: string; code?: number }>) {
  const calls: Call[] = [];
  const run = vi.fn(async (argv: string[]) => {
    calls.push({ argv });
    const key = argv.join(" ");
    const match = Object.entries(responses).find(([k]) => key.includes(k));
    const res = match?.[1] ?? {};
    return { stdout: res.stdout ?? "", stderr: "", code: res.code ?? 0 };
  });
  return { run, calls };
}

describe("performRollback", () => {
  it("refuses a dirty worktree and hands back the manual command", async () => {
    const { run, calls } = runner({ "status --porcelain": { stdout: " M src/x.ts" } });
    const result = await performRollback({ root: "/repo", prevSha: "good000", runCommand: run });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("uncommitted changes");
    expect(result.detail).toContain("git reset --hard good000");
    // Nothing destructive ran.
    expect(calls.some((c) => c.argv.includes("reset"))).toBe(false);
  });

  it("runs reset → install → build → restart in order on a clean tree", async () => {
    const { run, calls } = runner({});
    const result = await performRollback({ root: "/repo", prevSha: "good000", runCommand: run });
    expect(result.ok).toBe(true);
    const joined = calls.map((c) => c.argv.join(" "));
    const resetIdx = joined.findIndex((c) => c.includes("reset --hard good000"));
    const installIdx = joined.findIndex((c) => c === "pnpm install");
    const buildIdx = joined.findIndex((c) => c === "pnpm build");
    const restartIdx = joined.findIndex((c) => c.includes("gateway restart"));
    expect(resetIdx).toBeGreaterThan(-1);
    expect(installIdx).toBeGreaterThan(resetIdx);
    expect(buildIdx).toBeGreaterThan(installIdx);
    expect(restartIdx).toBeGreaterThan(buildIdx);
  });

  it("reports failure when the build breaks, after the reset already happened", async () => {
    const { run } = runner({ "pnpm build": { code: 1 } });
    const result = await performRollback({ root: "/repo", prevSha: "good000", runCommand: run });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("reset to good000");
    expect(result.detail).toContain("build FAILED");
  });

  it("still succeeds when only the best-effort restart fails (supervisor recovers)", async () => {
    const { run } = runner({ "gateway restart": { code: 1 } });
    const result = await performRollback({ root: "/repo", prevSha: "good000", runCommand: run });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("restart failed");
  });

  it("aborts before any mutation when git status itself fails", async () => {
    const { run, calls } = runner({ "status --porcelain": { code: 128 } });
    const result = await performRollback({ root: "/repo", prevSha: "good000", runCommand: run });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe("spawnBootWatchdog guards", () => {
  // The call-site contract the update paths rely on: no watchdog without the
  // kill switch on, a sha to return to, and an armed beacon.
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-watchdog-spawn-"));
    prev = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = dir;
    spawnMock.mockClear();
    // Defeat the test-env guard (spawn here is mocked; production tests never
    // launch a real detached process).
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("spawns detached with the beacon's armedAt when everything is in place", () => {
    armBootVerify({ prevSha: "good000", now: NOW });
    const spawned = spawnBootWatchdog({
      root: "/repo",
      prevSha: "good000",
      autoRollbackEnabled: true,
    });
    expect(spawned).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, argv, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean },
    ];
    expect(argv).toContain("boot-watchdog");
    expect(argv).toContain(String(NOW)); // the beacon's armedAt, not wall-clock
    expect(opts.detached).toBe(true);
  });

  it("no-ops when the kill switch is off (update.autoRollback.enabled=false)", () => {
    armBootVerify({ prevSha: "good000", now: NOW });
    expect(
      spawnBootWatchdog({ root: "/repo", prevSha: "good000", autoRollbackEnabled: false }),
    ).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("no-ops for package-mode updates (no sha to return to)", () => {
    armBootVerify({ prevSha: null, now: NOW });
    expect(spawnBootWatchdog({ root: "/repo", prevSha: null, autoRollbackEnabled: true })).toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("no-ops when no beacon is armed", () => {
    expect(
      spawnBootWatchdog({ root: "/repo", prevSha: "good000", autoRollbackEnabled: true }),
    ).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
