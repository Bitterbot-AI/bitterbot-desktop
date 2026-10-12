/**
 * PLAN-56 Phase 3b: update.run updates a release-tarball install in place
 * (verified download, snapshot, activation check, symlink switch), arms the
 * tarball boot check and restarts; update.check follows the GitHub release
 * that carries this platform's tarball and offers the in-place update.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import {
  armTarballBootVerify,
  runTarballUpdateForGateway,
} from "../../infra/tarball-update-flow.js";
import { spawnTarballBootWatchdog } from "../../infra/tarball-watchdog-spawn.js";
import { checkUpdateStatus, fetchLatestGithubRelease } from "../../infra/update-check.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { updateHandlers } from "./update.js";

vi.mock("../../config/config.js", () => ({ loadConfig: vi.fn(() => ({})) }));
vi.mock("../../infra/bitterbot-root.js", () => ({
  resolveBitterbotPackageRoot: vi.fn(async () => "/home/u/.bitterbot/app/1.4.0"),
}));
vi.mock("../../infra/update-runner.js", () => ({ runGatewayUpdate: vi.fn() }));
vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: vi.fn(() => ({ scheduled: true })),
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "",
  writeRestartSentinel: vi.fn(async () => "/tmp/sentinel.json"),
}));
vi.mock("../../infra/tarball-update-flow.js", () => ({
  runTarballUpdateForGateway: vi.fn(),
  armTarballBootVerify: vi.fn(() => ({ armedAt: 123, deadlineAt: 456, prevSha: null })),
}));
vi.mock("../../infra/tarball-watchdog-spawn.js", () => ({
  spawnTarballBootWatchdog: vi.fn(() => 999),
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    fetchLatestGithubRelease: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

function capture() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: { message?: string } }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) =>
    calls.push({ ok, payload, error });
  return { calls, respond };
}

const CTX = {
  appDir: "/home/u/.bitterbot/app",
  root: "/home/u/.bitterbot/app/1.4.0",
  fromVersion: "1.4.0",
  platformId: "linux-x64",
  autoRollback: true,
  memorySchemaLatest: 78,
};

describe("update RPCs for a release-tarball install", () => {
  beforeEach(() => {
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/home/u/.bitterbot/app/1.4.0",
      installKind: "tarball",
      packageManager: "pnpm",
    });
    vi.mocked(runGatewayUpdate).mockReset();
    vi.mocked(runTarballUpdateForGateway).mockReset();
    vi.mocked(armTarballBootVerify).mockClear();
    vi.mocked(spawnTarballBootWatchdog).mockClear();
    vi.mocked(scheduleGatewaySigusr1Restart).mockClear();
    for (const key of [
      "INVOCATION_ID",
      "SYSTEMD_EXEC_PID",
      "JOURNAL_STREAM",
      "LAUNCH_JOB_LABEL",
      "LAUNCH_JOB_NAME",
    ]) {
      delete process.env[key];
    }
  });

  it("update.run updates in place, arms the boot check and hands the restart to the respawn watchdog", async () => {
    vi.mocked(runTarballUpdateForGateway).mockResolvedValue({
      result: {
        status: "ok",
        mode: "tarball",
        root: CTX.root,
        before: { version: "1.4.0" },
        after: { version: "1.5.0" },
        steps: [],
        durationMs: 10,
      },
      ctx: CTX as never,
      update: { from: "1.4.0", to: "1.5.0", snapshotDir: "/s" } as never,
    });
    const { calls, respond } = capture();
    await updateHandlers["update.run"]!({ params: {}, respond } as never);
    expect(runGatewayUpdate).not.toHaveBeenCalled();
    expect(calls[0]?.ok).toBe(true);
    expect((calls[0]?.payload as { result: { status: string } } | undefined)?.result.status).toBe(
      "ok",
    );
    expect(armTarballBootVerify).toHaveBeenCalledWith(
      expect.objectContaining({ toVersion: "1.5.0", snapshotDir: "/s", restart: "respawn" }),
    );
    // Unsupervised: process-respawn spawns the watchdog at restart time.
    expect(spawnTarballBootWatchdog).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
  });

  it("under a supervisor the updater spawns the watchdog itself", async () => {
    process.env.INVOCATION_ID = "abc";
    vi.mocked(runTarballUpdateForGateway).mockResolvedValue({
      result: { status: "ok", mode: "tarball", steps: [], durationMs: 1 },
      ctx: CTX as never,
      update: { from: "1.4.0", to: "1.5.0", snapshotDir: "/s" } as never,
    });
    const { respond } = capture();
    await updateHandlers["update.run"]!({ params: {}, respond } as never);
    expect(armTarballBootVerify).toHaveBeenCalledWith(
      expect.objectContaining({ restart: "service" }),
    );
    expect(spawnTarballBootWatchdog).toHaveBeenCalledWith({ root: CTX.root, armedAt: 123 });
  });

  it("a failed or skipped tarball update never restarts the gateway", async () => {
    for (const status of ["error", "skipped"] as const) {
      vi.mocked(runTarballUpdateForGateway).mockResolvedValue({
        result: { status, mode: "tarball", reason: "x", steps: [], durationMs: 1 },
        ctx: CTX as never,
        update: null,
      });
      const { calls, respond } = capture();
      await updateHandlers["update.run"]!({ params: {}, respond } as never);
      expect(calls[0]?.ok).toBe(true);
    }
    expect(armTarballBootVerify).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("a second update.run while one is running is refused, and runs again once it finishes", async () => {
    let finish!: () => void;
    vi.mocked(runTarballUpdateForGateway).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              result: { status: "skipped", mode: "tarball", reason: "x", steps: [], durationMs: 1 },
              ctx: CTX as never,
              update: null,
            });
        }),
    );
    const first = capture();
    const second = capture();
    const running = updateHandlers["update.run"]!({ params: {}, respond: first.respond } as never);
    // Let the first run reach the updater.
    for (let i = 0; i < 20 && !finish; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await updateHandlers["update.run"]!({ params: {}, respond: second.respond } as never);
    expect(second.calls[0]?.ok).toBe(false);
    expect(second.calls[0]?.error?.message).toMatch(/already running/);
    expect(runTarballUpdateForGateway).toHaveBeenCalledTimes(1);
    finish();
    await running;
    expect(first.calls[0]?.ok).toBe(true);
    // Released: the next run goes through.
    vi.mocked(runTarballUpdateForGateway).mockResolvedValue({
      result: { status: "skipped", mode: "tarball", reason: "x", steps: [], durationMs: 1 },
      ctx: CTX as never,
      update: null,
    });
    const third = capture();
    await updateHandlers["update.run"]!({ params: {}, respond: third.respond } as never);
    expect(third.calls[0]?.ok).toBe(true);
  });

  it("update.check asks GitHub for this platform's tarball and offers the in-place update", async () => {
    vi.mocked(fetchLatestGithubRelease).mockResolvedValue({
      latestVersion: "999.0.0",
      source: "github-releases",
    });
    const { calls, respond } = capture();
    await updateHandlers["update.check"]!({ params: { fetch: true }, respond } as never);
    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as {
      registryLatest: string | null;
      updateCommand: string | null;
      staleness: { stale: boolean; reason: string };
    };
    expect(payload.registryLatest).toBe("999.0.0");
    // Not external any more: the UI shows its Update button.
    expect(payload.updateCommand).toBeNull();
    expect(payload.staleness).toMatchObject({ stale: true, reason: "package-version" });
    const call = vi.mocked(fetchLatestGithubRelease).mock.calls[0]?.[0];
    if (
      process.platform === "linux" ||
      (process.platform === "darwin" && process.arch === "arm64")
    ) {
      expect(call?.target).toEqual({
        kind: "tarball",
        platformId: `${process.platform}-${process.arch}`,
      });
    }
  });
});
