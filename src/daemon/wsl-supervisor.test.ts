import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecResult } from "./exec-file.js";
import { resolveGatewayService } from "./service.js";
import { resolveWslSupervisorPaths } from "./wsl-supervisor-record.js";
import {
  createWslSupervisorService,
  installWslSupervisor,
  readWslSupervisorRuntime,
  resolveLauncherFromProgramArguments,
  resolveSupervisedPort,
  type WslSupervisorDeps,
} from "./wsl-supervisor.js";

const SYSTEM32 = "/mnt/c/Windows/System32";
const LAUNCHER = "/home/vicmg/.bitterbot/app/current/bin/bitterbot";

function captureStream(): { stream: Writable; text: () => string } {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += String(chunk);
      callback();
    },
  });
  return { stream, text: () => buffer };
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", code: 0 };
}

function fakeExec(overrides: { schtasks?: (args: string[]) => ExecResult }): {
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  calls: Array<[string, string[]]>;
} {
  const calls: Array<[string, string[]]> = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push([command, args]);
    if (command.endsWith("cmd.exe")) {
      if (args[1]?.includes("%TEMP%")) {
        return ok("C:\\Users\\vicmg\\AppData\\Local\\Temp\r\n");
      }
      return ok("VICTOR-PC\\vicmg\r\n");
    }
    if (command === "wslpath") {
      if (args[0] === "-u") {
        return ok("/mnt/c/Users/vicmg/AppData/Local/Temp\n");
      }
      return ok(`C:\\Users\\vicmg\\AppData\\Local\\Temp\\${path.basename(args[1] ?? "")}\n`);
    }
    if (command.endsWith("schtasks.exe")) {
      return overrides.schtasks?.(args) ?? ok("");
    }
    return { stdout: "", stderr: `unexpected ${command}`, code: 1 };
  };
  return { exec, calls };
}

describe("resolveGatewayService backend selection", () => {
  it.each([
    { platform: "linux", wsl: true, systemd: false, label: "wsl-supervisor" },
    { platform: "linux", wsl: true, systemd: true, label: "systemd" },
    { platform: "linux", wsl: false, systemd: false, label: "systemd" },
    { platform: "linux", wsl: false, systemd: true, label: "systemd" },
    { platform: "darwin", wsl: false, systemd: false, label: "LaunchAgent" },
    { platform: "win32", wsl: false, systemd: false, label: "Scheduled Task" },
  ] as const)(
    "$platform wsl=$wsl systemd=$systemd -> $label",
    ({ platform, wsl, systemd, label }) => {
      const service = resolveGatewayService({
        platform,
        isWsl: () => wsl,
        systemdUserAvailable: () => systemd,
      });
      expect(service.label).toBe(label);
      expect(service.supportsDryRun ?? false).toBe(label === "wsl-supervisor");
    },
  );
});

describe("wsl-supervisor backend", () => {
  let home: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "bb-wsl-sup-"));
    env = { HOME: home, USER: "vicmg", WSL_DISTRO_NAME: "Ubuntu" };
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const interopExists = (p: string) => p.startsWith(SYSTEM32) || p === LAUNCHER;

  function baseDeps(overrides: Partial<WslSupervisorDeps> = {}): WslSupervisorDeps & {
    written: Array<{ path: string; data: Buffer }>;
    unlinked: string[];
    spawned: Array<{ command: string; args: string[] }>;
  } {
    const written: Array<{ path: string; data: Buffer }> = [];
    const unlinked: string[] = [];
    const spawned: Array<{ command: string; args: string[] }> = [];
    return {
      written,
      unlinked,
      spawned,
      existsSync: interopExists,
      isPidAlive: () => false,
      writeFile: async (p, data) => {
        written.push({ path: p, data });
      },
      unlink: async (p) => {
        unlinked.push(p);
      },
      spawnDetached: (command, args) => {
        spawned.push({ command, args });
        return 777;
      },
      kill: () => undefined,
      isPortOpen: async () => false,
      readGatewayLockOwner: async () => ({ status: "none", pid: null, lockPath: "/x" }),
      sleep: async () => undefined,
      processEnv: {},
      ...overrides,
    };
  }

  const installArgs = (stdout: Writable, dryRun = false) => ({
    env,
    stdout,
    programArguments: [LAUNCHER, "gateway", "--port", "19001"],
    environment: {
      HOME: home,
      BITTERBOT_GATEWAY_PORT: "19001",
      BITTERBOT_SERVICE_VERSION: "1.11.0",
    },
    dryRun,
  });

  it("dry run prints the task XML and the commands without writing, registering or starting", async () => {
    const { stream, text } = captureStream();
    const { exec, calls } = fakeExec({});
    const deps = baseDeps({ exec });
    await installWslSupervisor(installArgs(stream, true), deps);
    const out = text();
    expect(out).toContain("Dry run: nothing was written");
    expect(out).toContain(
      `${SYSTEM32}/schtasks.exe /Create /F /TN "Bitterbot Gateway (WSL Ubuntu)" /XML "C:\\Users\\vicmg\\AppData\\Local\\Temp\\bitterbot-gateway-task-`,
    );
    expect(out).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(out).toContain(
      `<Arguments>-d Ubuntu -u vicmg -- ${LAUNCHER} gateway supervise</Arguments>`,
    );
    expect(out).toContain(`Would start: ${LAUNCHER} gateway supervise (detached)`);
    expect(deps.written).toEqual([]);
    expect(deps.spawned).toEqual([]);
    expect(calls.some(([command]) => command.endsWith("schtasks.exe"))).toBe(false);
    await expect(fs.access(resolveWslSupervisorPaths(env).recordPath)).rejects.toThrow();
  });

  it("install records the command, registers the task from a UTF-16 XML in the Windows temp dir and starts the supervisor", async () => {
    const { stream, text } = captureStream();
    const { exec, calls } = fakeExec({});
    const deps = baseDeps({ exec });
    const result = await installWslSupervisor(installArgs(stream), deps);

    expect(result.taskName).toBe("Bitterbot Gateway (WSL Ubuntu)");
    expect(result.supervisorPid).toBe(777);
    const record = JSON.parse(await fs.readFile(result.recordPath, "utf8"));
    expect(record.programArguments).toEqual([LAUNCHER, "gateway", "--port", "19001"]);
    expect(record.environment.BITTERBOT_GATEWAY_PORT).toBe("19001");
    expect(record.taskName).toBe("Bitterbot Gateway (WSL Ubuntu)");

    expect(deps.written).toHaveLength(1);
    expect(deps.written[0].path).toMatch(
      /^\/mnt\/c\/Users\/vicmg\/AppData\/Local\/Temp\/bitterbot-gateway-task-\d+\.xml$/,
    );
    expect([...deps.written[0].data.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(deps.written[0].data.subarray(2).toString("utf16le")).toContain("<Task version=");
    expect(deps.unlinked).toEqual([deps.written[0].path]);

    const create = calls.find(
      ([command, args]) => command.endsWith("schtasks.exe") && args[0] === "/Create",
    );
    expect(create?.[1]).toEqual([
      "/Create",
      "/F",
      "/TN",
      "Bitterbot Gateway (WSL Ubuntu)",
      "/XML",
      `C:\\Users\\vicmg\\AppData\\Local\\Temp\\${path.basename(deps.written[0].path)}`,
    ]);
    expect(deps.spawned).toEqual([{ command: LAUNCHER, args: ["gateway", "supervise"] }]);
    expect(text()).toContain("Registered logon task");
    expect(text()).toContain("Started gateway supervisor");
  });

  it("install without Windows interop still installs the supervisor and says no boot trigger was registered", async () => {
    const { stream, text } = captureStream();
    const { exec, calls } = fakeExec({});
    const deps = baseDeps({ exec, existsSync: (p) => p === LAUNCHER });
    const result = await installWslSupervisor(installArgs(stream), deps);
    expect(result.taskName).toBeNull();
    expect(calls).toEqual([]);
    expect(text()).toContain("not reachable from this distro, so no logon task was registered");
    expect(text()).toContain("Enable interop in /etc/wsl.conf");
    expect(deps.spawned).toHaveLength(1);
    await expect(fs.access(result.recordPath)).resolves.toBeUndefined();
  });

  it("install surfaces a schtasks failure and still removes the temp XML", async () => {
    const { stream } = captureStream();
    const { exec } = fakeExec({
      schtasks: () => ({ stdout: "", stderr: "ERROR: Access is denied.", code: 1 }),
    });
    const deps = baseDeps({ exec });
    await expect(installWslSupervisor(installArgs(stream), deps)).rejects.toThrow(
      /Access is denied/,
    );
    expect(deps.unlinked).toHaveLength(1);
    expect(deps.spawned).toEqual([]);
  });

  it("does not start a second supervisor when one is alive", async () => {
    const { stream, text } = captureStream();
    const { exec } = fakeExec({});
    const paths = resolveWslSupervisorPaths(env);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.lockPath, JSON.stringify({ pid: 4242, createdAt: "x" }));
    const deps = baseDeps({ exec, isPidAlive: (pid) => pid === 4242 });
    await installWslSupervisor(installArgs(stream), deps);
    expect(deps.spawned).toEqual([]);
    expect(text()).toContain("Supervisor already running: pid 4242");
  });

  it("isLoaded is true for a live supervisor or a registered task, false otherwise", async () => {
    const { exec: withTask } = fakeExec({ schtasks: () => ok("Status: Ready") });
    const { exec: noTask } = fakeExec({
      schtasks: () => ({
        stdout: "",
        stderr: "ERROR: The system cannot find the file specified.",
        code: 1,
      }),
    });
    expect(await createWslSupervisorService(baseDeps({ exec: noTask })).isLoaded({ env })).toBe(
      false,
    );
    expect(await createWslSupervisorService(baseDeps({ exec: withTask })).isLoaded({ env })).toBe(
      true,
    );
    const paths = resolveWslSupervisorPaths(env);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.pidPath, "4242\n");
    expect(
      await createWslSupervisorService(
        baseDeps({ exec: noTask, isPidAlive: (pid) => pid === 4242 }),
      ).isLoaded({ env }),
    ).toBe(true);
  });

  it("status shows supervisor pid, gateway pid, port, task state and the last three exits", async () => {
    const paths = resolveWslSupervisorPaths(env);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.writeFile(paths.lockPath, JSON.stringify({ pid: 4242, createdAt: "x" }));
    await fs.writeFile(
      paths.recordPath,
      JSON.stringify({
        programArguments: [LAUNCHER, "gateway", "--port", "19001"],
        environment: { HOME: home },
      }),
    );
    await fs.writeFile(
      paths.exitsLogPath,
      ["t1 pid=1 exit=1", "t2 pid=2 exit=1", "t3 pid=3 exit=0", "t4 pid=4 exit=1"].join("\n") +
        "\n",
    );
    const { exec } = fakeExec({
      schtasks: () =>
        ok(
          [
            "TaskName: \\Bitterbot Gateway (WSL Ubuntu)",
            "Status: Ready",
            "Last Run Time: 10/29/2026 8:00:00 AM",
            "Last Run Result: 0x0",
          ].join("\r\n"),
        ),
    });
    const runtime = await readWslSupervisorRuntime(
      env,
      baseDeps({
        exec,
        isPidAlive: (pid) => pid === 4242,
        isPortOpen: async (port) => port === 19001,
        readGatewayLockOwner: async () => ({ status: "alive", pid: 13753, lockPath: "/x" }),
      }),
    );
    expect(runtime.status).toBe("running");
    expect(runtime.pid).toBe(13753);
    expect(runtime.state).toBe("supervised");
    expect(runtime.lines).toEqual([
      "Supervisor: pid 4242",
      "Gateway: pid 13753 (holds the gateway lock)",
      "Port 19001: listening",
      "Logon task: Ready, last run 10/29/2026 8:00:00 AM (0x0)",
      "Last exits:",
      "  t2 pid=2 exit=1",
      "  t3 pid=3 exit=0",
      "  t4 pid=4 exit=1",
    ]);
  });

  it("status reports a missing install when nothing is recorded, running or registered", async () => {
    const { exec } = fakeExec({
      schtasks: () => ({ stdout: "", stderr: "ERROR: cannot find the file", code: 1 }),
    });
    const runtime = await readWslSupervisorRuntime(env, baseDeps({ exec }));
    expect(runtime.missingUnit).toBe(true);
    expect(runtime.status).toBe("stopped");
  });

  it("stop signals the supervisor and waits for it to exit", async () => {
    const paths = resolveWslSupervisorPaths(env);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(paths.pidPath, "4242\n");
    let alive = true;
    const kills: Array<[number, string]> = [];
    const { stream, text } = captureStream();
    const service = createWslSupervisorService(
      baseDeps({
        exec: fakeExec({}).exec,
        isPidAlive: (pid) => pid === 4242 && alive,
        kill: (pid, signal) => {
          kills.push([pid, signal]);
          alive = false;
        },
      }),
    );
    await service.stop({ env, stdout: stream });
    expect(kills).toEqual([[4242, "SIGTERM"]]);
    expect(text()).toContain("Stopped gateway supervisor: pid 4242");
  });

  it("uninstall removes the task, the lock files and the recorded command", async () => {
    const paths = resolveWslSupervisorPaths(env);
    await fs.mkdir(paths.runDir, { recursive: true });
    await fs.writeFile(
      paths.recordPath,
      JSON.stringify({ programArguments: [LAUNCHER, "gateway"] }),
    );
    await fs.writeFile(paths.lockPath, JSON.stringify({ pid: 1, createdAt: "x" }));
    await fs.writeFile(paths.pidPath, "1\n");
    const { exec, calls } = fakeExec({
      schtasks: (args) => (args[0] === "/Query" ? ok("Status: Ready") : ok("")),
    });
    const { stream, text } = captureStream();
    await createWslSupervisorService(baseDeps({ exec })).uninstall({ env, stdout: stream });
    const del = calls.find(
      ([command, args]) => command.endsWith("schtasks.exe") && args[0] === "/Delete",
    );
    expect(del?.[1]).toEqual(["/Delete", "/F", "/TN", "Bitterbot Gateway (WSL Ubuntu)"]);
    await expect(fs.access(paths.recordPath)).rejects.toThrow();
    await expect(fs.access(paths.lockPath)).rejects.toThrow();
    await expect(fs.access(paths.pidPath)).rejects.toThrow();
    expect(text()).toContain("Removed logon task");
  });

  it("derives the launcher and the port from the recorded program arguments", () => {
    expect(resolveLauncherFromProgramArguments([LAUNCHER, "gateway", "--port", "1"])).toEqual([
      LAUNCHER,
    ]);
    expect(
      resolveLauncherFromProgramArguments(["/usr/bin/node", "/opt/bb/dist/entry.js", "gateway"]),
    ).toEqual(["/usr/bin/node", "/opt/bb/dist/entry.js"]);
    expect(resolveSupervisedPort([LAUNCHER, "gateway", "--port", "18789"], "19001")).toBe(18789);
    expect(resolveSupervisedPort([LAUNCHER, "gateway"], "18001")).toBe(18001);
    expect(resolveSupervisedPort(undefined, undefined)).toBe(19001);
  });
});
