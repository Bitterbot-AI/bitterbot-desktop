import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => ({
  isLoaded: vi.fn(),
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "systemd",
    isLoaded: serviceMock.isLoaded,
    readCommand: serviceMock.readCommand,
    readRuntime: serviceMock.readRuntime,
  }),
}));

import {
  findLinuxListenerPid,
  inspectGatewayService,
  resolveProcessRoot,
  resolveRootFromArgs,
  tarballRootFromExe,
  type ProcInfo,
} from "./gateway-switch-system.js";

let work: string;
let clone: string;
let appDir: string;
let v140: string;
let v150: string;

function writePkg(dir: string, version: string) {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bitterbot", version }));
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "");
  fs.writeFileSync(path.join(dir, "dist", "entry.js"), "");
  fs.writeFileSync(path.join(dir, "bitterbot.mjs"), "");
}

beforeAll(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bb-switch-")));
  clone = path.join(work, "bitterbot-desktop");
  writePkg(clone, "1.4.0");
  fs.mkdirSync(path.join(clone, ".git"));
  appDir = path.join(work, "app");
  v140 = path.join(appDir, "1.4.0");
  v150 = path.join(appDir, "1.5.0");
  for (const [dir, version] of [
    [v140, "1.4.0"],
    [v150, "1.5.0"],
  ] as const) {
    writePkg(dir, version);
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "bitterbot"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, ".bitterbot-install-kind"), "tarball\n");
  }
  fs.symlinkSync("1.5.0", path.join(appDir, "current"));
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("tarballRootFromExe", () => {
  it("finds the version directory of a bundled node", () => {
    expect(tarballRootFromExe("/home/u/.bitterbot/app/1.4.0/runtime/node/bin/node")).toBe(
      "/home/u/.bitterbot/app/1.4.0",
    );
    expect(tarballRootFromExe("C:\\bb\\1.4.0\\runtime\\node\\bin\\node.exe")).toBe("C:\\bb\\1.4.0");
    expect(tarballRootFromExe("/home/u/.nvm/versions/node/v22.22.1/bin/node")).toBeNull();
    expect(tarballRootFromExe(null)).toBeNull();
  });
});

describe("resolveRootFromArgs", () => {
  it("resolves a clone's dist entry, relative entries against the cwd, and the current launcher", async () => {
    expect(
      await resolveRootFromArgs(
        ["/usr/bin/node", path.join(clone, "dist", "index.js"), "gateway", "--port", "19001"],
        null,
      ),
    ).toBe(clone);
    expect(await resolveRootFromArgs(["node", "bitterbot.mjs", "gateway"], clone)).toBe(clone);
    // <app>/current/bin/bitterbot follows `current` to the version it names.
    expect(
      await resolveRootFromArgs(
        [path.join(appDir, "current", "bin", "bitterbot"), "gateway"],
        null,
      ),
    ).toBe(v150);
    expect(await resolveRootFromArgs(["/usr/bin/python3", "-m", "http.server"], work)).toBeNull();
  });
});

describe("resolveProcessRoot", () => {
  it("a release-tarball gateway is located by its bundled node", async () => {
    const info = (pid: number): Promise<ProcInfo | null> =>
      Promise.resolve(
        pid === 10
          ? {
              pid,
              ppid: 1,
              commandLine: "bitterbot-gateway",
              exe: path.join(v140, "runtime", "node", "bin", "node"),
              cwd: "/tmp",
            }
          : null,
      );
    const res = await resolveProcessRoot(10, info);
    expect(res.root).toBe(v140);
    expect(res.command).toBe("bitterbot-gateway");
  });

  it("a `pnpm start gateway` gateway (title replaced) is located through its parents' cwd", async () => {
    const procs: Record<number, ProcInfo> = {
      30: { pid: 30, ppid: 20, commandLine: "bitterbot-gateway", exe: "/usr/bin/node", cwd: "/" },
      20: { pid: 20, ppid: 10, commandLine: "bitterbot", exe: "/usr/bin/node", cwd: "/" },
      10: {
        pid: 10,
        ppid: 5,
        commandLine: "node scripts/run-node.mjs gateway",
        exe: "/usr/bin/node",
        cwd: clone,
      },
    };
    const res = await resolveProcessRoot(30, async (pid) => procs[pid] ?? null);
    expect(res.root).toBe(clone);
    expect(res.exe).toBe("/usr/bin/node");
    expect(res.ancestors).toEqual([30, 20, 10]);
  });

  it("gives up (null root) rather than guess", async () => {
    const res = await resolveProcessRoot(30, async (pid) =>
      pid === 30
        ? { pid, ppid: 1, commandLine: "bitterbot-gateway", exe: "/usr/bin/node", cwd: "/" }
        : null,
    );
    expect(res.root).toBeNull();
  });
});

describe("inspectGatewayService", () => {
  const selfRef = () => ({ root: v150, kind: "tarball" as const, version: "1.5.0" });

  it("reports a git-clone service as elsewhere, with what it runs", async () => {
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: ["/usr/bin/node", path.join(clone, "dist", "index.js"), "gateway"],
    });
    serviceMock.readRuntime.mockResolvedValue({ status: "running", pid: 123 });
    const found = await inspectGatewayService({ self: selfRef(), env: {} });
    expect(found).toMatchObject({
      pointsHere: false,
      running: true,
      pid: 123,
      followsCurrent: false,
      runsFrom: { root: clone, kind: "git", version: "1.4.0" },
    });
  });

  it("a tarball service on the current launcher points here once current is this version", async () => {
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({
      programArguments: [path.join(appDir, "current", "bin", "bitterbot"), "gateway"],
    });
    serviceMock.readRuntime.mockResolvedValue({ status: "stopped" });
    const found = await inspectGatewayService({ self: selfRef(), env: {} });
    expect(found).toMatchObject({ pointsHere: true, followsCurrent: true, running: false });
  });

  it("no service installed, or no service manager: null", async () => {
    serviceMock.isLoaded.mockResolvedValue(false);
    expect(await inspectGatewayService({ self: selfRef(), env: {} })).toBeNull();
    serviceMock.isLoaded.mockRejectedValue(new Error("systemctl --user unavailable"));
    expect(await inspectGatewayService({ self: selfRef(), env: {} })).toBeNull();
  });

  it("an unresolvable definition is left alone (counts as pointing here)", async () => {
    serviceMock.isLoaded.mockResolvedValue(true);
    serviceMock.readCommand.mockResolvedValue({ programArguments: ["bitterbot", "gateway"] });
    serviceMock.readRuntime.mockResolvedValue({ status: "running" });
    const found = await inspectGatewayService({ self: selfRef(), env: {} });
    expect(found?.pointsHere).toBe(true);
    expect(found?.runsFrom).toBeNull();
  });
});

describe("findLinuxListenerPid (no lsof)", () => {
  it("maps a LISTEN socket on the port to the pid holding it", async () => {
    const proc = path.join(work, "proc");
    fs.mkdirSync(path.join(proc, "net"), { recursive: true });
    const header =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
    // 19001 = 0x4A39: one LISTEN (0A) socket, one ESTABLISHED (01) socket on the same port.
    fs.writeFileSync(
      path.join(proc, "net", "tcp"),
      header +
        "   0: 0100007F:4A39 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0 100 0 0 10 0\n" +
        "   1: 0100007F:4A39 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 6666 1 0 20 4 30 10 -1\n",
    );
    fs.writeFileSync(path.join(proc, "net", "tcp6"), header);
    for (const [pid, inode] of [
      ["200", "6666"],
      ["321", "5555"],
    ] as const) {
      fs.mkdirSync(path.join(proc, pid, "fd"), { recursive: true });
      fs.symlinkSync(`socket:[${inode}]`, path.join(proc, pid, "fd", "7"));
    }
    expect(await findLinuxListenerPid(19001, proc)).toBe(321);
    expect(await findLinuxListenerPid(19004, proc)).toBeNull();
  });
});
