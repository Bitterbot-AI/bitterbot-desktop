/**
 * gateway-presence (PLAN-56 Phase 3b): a rollback may replace a memory
 * database only after every sign of a running gateway is gone. Ports are
 * ephemeral loopback ports and lock files live in temp directories: the
 * real gateway lock and port are never touched.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGatewayLockOwner } from "./gateway-lock.js";
import {
  checkGatewayGone,
  probeLoopbackPort,
  processGroupAlive,
  waitForGatewayGone,
} from "./gateway-presence.js";

const noLock = async () => ({ status: "none" as const, pid: null, lockPath: "" });

describe("probeLoopbackPort", () => {
  it("open while something listens, closed after it stops", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    expect(await probeLoopbackPort(port)).toBe("open");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeLoopbackPort(port)).toBe("closed");
  });
});

describe("checkGatewayGone", () => {
  it("gone only when the lock, the port and the process group are all clear", async () => {
    expect(
      await checkGatewayGone({
        port: 19001,
        pgid: 4242,
        lockOwner: noLock,
        probePort: async () => "closed",
        groupAlive: () => false,
      }),
    ).toMatchObject({ gone: true });
    const dead = async () => ({ status: "dead" as const, pid: 7, lockPath: "" });
    expect(
      (await checkGatewayGone({ port: 19001, lockOwner: dead, probePort: async () => "closed" }))
        .gone,
    ).toBe(true);
  });

  it("a held lock, an answering or unprobeable port, or a live group each mean running", async () => {
    const alive = async () => ({ status: "alive" as const, pid: 99, lockPath: "" });
    const unknown = async () => ({ status: "unknown" as const, pid: null, lockPath: "" });
    const cases = [
      { lockOwner: alive, probePort: async () => "closed" as const, want: /pid 99/ },
      { lockOwner: unknown, probePort: async () => "closed" as const, want: /cannot be read/ },
      { lockOwner: noLock, probePort: async () => "open" as const, want: /accepts connections/ },
      {
        lockOwner: noLock,
        probePort: async () => "unknown" as const,
        want: /could not be checked/,
      },
    ];
    for (const c of cases) {
      const res = await checkGatewayGone({ port: 19001, ...c, groupAlive: () => false });
      expect(res.gone).toBe(false);
      expect(res.detail).toMatch(c.want);
    }
    const group = await checkGatewayGone({
      port: null,
      pgid: 4242,
      lockOwner: noLock,
      groupAlive: () => true,
    });
    expect(group).toMatchObject({ gone: false });
    expect(group.detail).toMatch(/process group 4242/);
    const throwing = await checkGatewayGone({
      port: null,
      lockOwner: async () => {
        throw new Error("EACCES");
      },
    });
    expect(throwing.gone).toBe(false);
  });

  it("waitForGatewayGone polls until confirmed, and gives up with the last reason", async () => {
    let probes = 0;
    let t = 0;
    const res = await waitForGatewayGone({
      port: 19001,
      lockOwner: noLock,
      probePort: async () => (++probes < 3 ? "open" : "closed"),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 10_000,
    });
    expect(res.gone).toBe(true);
    // Gone twice in a row: closed on the 3rd and 4th probe.
    expect(probes).toBe(4);
    t = 0;
    const never = await waitForGatewayGone({
      port: 19001,
      lockOwner: noLock,
      probePort: async () => "open",
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 2_000,
    });
    expect(never.gone).toBe(false);
    // A gap (gone once, then back) is not enough.
    t = 0;
    let n = 0;
    const flapping = await waitForGatewayGone({
      port: 19001,
      lockOwner: noLock,
      probePort: async () => (++n % 2 === 0 ? "closed" : "open"),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 5_000,
    });
    expect(flapping.gone).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("processGroupAlive", () => {
  it("tracks a detached process group", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    try {
      expect(processGroupAlive(child.pid!)).toBe(true);
    } finally {
      process.kill(-child.pid!, "SIGKILL");
    }
    await new Promise((r) => child.once("exit", r));
    for (let i = 0; i < 50 && processGroupAlive(child.pid!); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(processGroupAlive(child.pid!)).toBe(false);
  });
});

describe("readGatewayLockOwner", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gw-lock-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("none without a lock file, dead for an exited owner, alive for a live one", async () => {
    const lockPath = path.join(dir, "gateway.test.lock");
    expect((await readGatewayLockOwner({ lockPath })).status).toBe("none");
    const write = (pid: number) =>
      fs.writeFileSync(
        lockPath,
        JSON.stringify({ pid, createdAt: new Date().toISOString(), configPath: "/x" }),
      );
    write(2 ** 22 + 12345);
    expect((await readGatewayLockOwner({ lockPath, platform: "darwin" })).status).toBe("dead");
    write(process.pid);
    expect(await readGatewayLockOwner({ lockPath, platform: "darwin" })).toMatchObject({
      status: "alive",
      pid: process.pid,
    });
    fs.writeFileSync(lockPath, "{not json");
    expect((await readGatewayLockOwner({ lockPath })).status).toBe("unknown");
  });
});
