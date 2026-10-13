import { afterEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const watchdogMock = vi.hoisted(() => vi.fn((_params: unknown) => 7777 as number | null));
vi.mock("./tarball-watchdog-spawn.js", () => ({
  spawnTarballBootWatchdog: (params: unknown) => watchdogMock(params),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { armBootVerify } from "./boot-verify.js";
import { restartGatewayProcessWithFreshPid } from "./process-respawn.js";

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const envSnapshot = captureFullEnv();

afterEach(() => {
  envSnapshot.restore();
  process.argv = [...originalArgv];
  process.execArgv = [...originalExecArgv];
  spawnMock.mockReset();
  watchdogMock.mockClear();
});

function clearSupervisorHints() {
  delete process.env.LAUNCH_JOB_LABEL;
  delete process.env.LAUNCH_JOB_NAME;
  delete process.env.INVOCATION_ID;
  delete process.env.SYSTEMD_EXEC_PID;
  delete process.env.JOURNAL_STREAM;
}

describe("restartGatewayProcessWithFreshPid", () => {
  it("returns disabled when BITTERBOT_NO_RESPAWN is set", () => {
    process.env.BITTERBOT_NO_RESPAWN = "1";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("disabled");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns supervised when launchd/systemd hints are present", () => {
    process.env.LAUNCH_JOB_LABEL = "ai.bitterbot.gateway";
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("supervised");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns detached child with current exec argv", () => {
    delete process.env.BITTERBOT_NO_RESPAWN;
    clearSupervisorHints();
    process.execArgv = ["--import", "tsx"];
    process.argv = ["/usr/local/bin/node", "/repo/dist/index.js", "gateway", "run"];
    spawnMock.mockReturnValue({ pid: 4242, unref: vi.fn() });

    const result = restartGatewayProcessWithFreshPid();

    expect(result).toEqual({ mode: "spawned", pid: 4242 });
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ["--import", "tsx", "/repo/dist/index.js", "gateway", "run"],
      expect.objectContaining({
        detached: true,
        stdio: "inherit",
      }),
    );
  });

  it("returns failed when spawn throws", () => {
    delete process.env.BITTERBOT_NO_RESPAWN;
    clearSupervisorHints();

    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    const result = restartGatewayProcessWithFreshPid();
    expect(result.mode).toBe("failed");
    expect(result.detail).toContain("spawn failed");
  });
});

// Symlinks need privileges on Windows; tarball installs are Linux/macOS only.
const describeUnix = process.platform === "win32" ? describe.skip : describe;

describeUnix(
  "restartGatewayProcessWithFreshPid for a release-tarball install (PLAN-56 Phase 3b)",
  () => {
    let work: string;
    let appDir: string;

    function setup() {
      work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-respawn-"));
      appDir = path.join(work, "app");
      for (const v of ["1.4.0", "1.5.0"]) {
        fs.mkdirSync(path.join(appDir, v, "bin"), { recursive: true });
        fs.writeFileSync(path.join(appDir, v, "bin", "bitterbot"), "#!/bin/sh\n", { mode: 0o755 });
      }
      fs.symlinkSync("1.5.0", path.join(appDir, "current"));
      delete process.env.BITTERBOT_NO_RESPAWN;
      clearSupervisorHints();
      process.env.BITTERBOT_STATE_DIR = path.join(work, "state");
      process.env.BITTERBOT_INSTALL_KIND = "tarball";
      process.env.BITTERBOT_INSTALL_ROOT = path.join(appDir, "1.4.0");
      process.argv = [
        path.join(appDir, "1.4.0", "runtime", "node", "bin", "node"),
        path.join(appDir, "1.4.0", "dist", "entry.js"),
        "gateway",
        "--allow-unconfigured",
      ];
    }

    afterEach(() => {
      if (work) {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });

    function armRespawn() {
      return armBootVerify({
        prevSha: null,
        expectedVersion: "1.5.0",
        tarball: {
          appDir: fs.realpathSync(appDir),
          fromVersion: "1.4.0",
          toVersion: "1.5.0",
          restart: "respawn",
          snapshotDir: null,
          fromMemorySchemaLatest: 78,
          autoRollback: true,
        },
      })!;
    }

    it("restarts through <appDir>/current/bin/bitterbot, not its own (old) version directory", () => {
      setup();
      spawnMock.mockReturnValue({ pid: 4243, unref: vi.fn() });
      const result = restartGatewayProcessWithFreshPid();
      expect(result.mode).toBe("spawned");
      const [cmd, args, opts] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      expect(cmd).toBe(path.join(fs.realpathSync(appDir), "current", "bin", "bitterbot"));
      expect(args).toEqual(["gateway", "--allow-unconfigured"]);
      expect(opts.env.BITTERBOT_INSTALL_ROOT).toBeUndefined();
      expect(watchdogMock).not.toHaveBeenCalled();
    });

    it("with an update pending, hands the restart to the watchdog with the gateway argv", () => {
      setup();
      const beacon = armRespawn();
      const result = restartGatewayProcessWithFreshPid();
      expect(result).toMatchObject({ mode: "spawned", pid: 7777 });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(watchdogMock).toHaveBeenCalledWith({
        root: fs.realpathSync(path.join(appDir, "1.4.0")),
        armedAt: beacon.armedAt,
        respawnArgv: ["gateway", "--allow-unconfigured"],
        waitPid: process.pid,
      });
    });

    it("under a supervisor with an update pending, starts a watching-only watchdog", () => {
      setup();
      const beacon = armRespawn();
      process.env.INVOCATION_ID = "x";
      const result = restartGatewayProcessWithFreshPid();
      expect(result.mode).toBe("supervised");
      expect(watchdogMock).toHaveBeenCalledWith({
        root: fs.realpathSync(path.join(appDir, "1.4.0")),
        armedAt: beacon.armedAt,
      });
    });
  },
);
