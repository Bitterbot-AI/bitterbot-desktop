import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSupervisorLock,
  DailyGatewayLog,
  readSupervisorPid,
  readWslSupervisorRecord,
  removeStaleOrchestratorSocket,
  resolveWslSupervisorPaths,
  writeWslSupervisorRecord,
} from "./wsl-supervisor-record.js";

describe("wsl supervisor on-disk state", () => {
  let home: string;
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "bb-wsl-rec-"));
    env = { HOME: home };
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("puts everything under the state dir, nothing root-owned", () => {
    const paths = resolveWslSupervisorPaths(env);
    expect(paths.recordPath).toBe(path.join(home, ".bitterbot", "run", "gateway-supervisor.json"));
    expect(paths.lockPath).toBe(path.join(home, ".bitterbot", "run", "gateway-supervisor.lock"));
    expect(paths.exitsLogPath).toBe(path.join(home, ".bitterbot", "logs", "gateway-exits.log"));
    expect(resolveWslSupervisorPaths({ ...env, BITTERBOT_PROFILE: "rescue" }).stateDir).toBe(
      path.join(home, ".bitterbot-rescue"),
    );
  });

  it("round-trips the recorded command and drops empty environment values", async () => {
    await writeWslSupervisorRecord(env, {
      programArguments: ["/launcher", "gateway", "--port", "19001"],
      workingDirectory: "/home/u",
      environment: { HOME: "/home/u", BITTERBOT_GATEWAY_TOKEN: "" },
      taskName: "Bitterbot Gateway (WSL Ubuntu)",
    });
    const record = await readWslSupervisorRecord(env);
    expect(record?.programArguments).toEqual(["/launcher", "gateway", "--port", "19001"]);
    expect(record?.workingDirectory).toBe("/home/u");
    expect(record?.environment).toEqual({ HOME: "/home/u" });
    expect(record?.taskName).toBe("Bitterbot Gateway (WSL Ubuntu)");
    expect(await readWslSupervisorRecord({ HOME: path.join(home, "nope") })).toBeNull();
  });

  it("single instance: a live owner keeps the lock, a dead one is treated as stale", async () => {
    const first = await acquireSupervisorLock(env, { isPidAlive: () => true, selfPid: 100 });
    expect("held" in first).toBe(false);
    const second = await acquireSupervisorLock(env, { isPidAlive: () => true, selfPid: 200 });
    expect(second).toEqual({ held: true, pid: 100 });
    expect(await readSupervisorPid(env, { isPidAlive: (pid) => pid === 100 })).toBe(100);

    const third = await acquireSupervisorLock(env, { isPidAlive: () => false, selfPid: 300 });
    expect("held" in third).toBe(false);
    const paths = resolveWslSupervisorPaths(env);
    expect(JSON.parse(await fs.readFile(paths.lockPath, "utf8")).pid).toBe(300);
    expect((await fs.readFile(paths.pidPath, "utf8")).trim()).toBe("300");
    if (!("held" in third)) {
      await third.release();
    }
    await expect(fs.access(paths.lockPath)).rejects.toThrow();
    expect(await readSupervisorPid(env, { isPidAlive: () => true })).toBeNull();
  });

  it("writes a new daily log file per calendar day and keeps the newest 14", async () => {
    const logDir = path.join(home, ".bitterbot", "logs");
    await fs.mkdir(logDir, { recursive: true });
    for (let day = 1; day <= 15; day += 1) {
      await fs.writeFile(
        path.join(logDir, `gateway-202610${String(day).padStart(2, "0")}.log`),
        "old\n",
      );
    }
    await fs.writeFile(path.join(logDir, "gateway-exits.log"), "keep\n");
    let now = new Date(2026, 9, 29, 10, 0, 0);
    const log = new DailyGatewayLog(logDir, { now: () => now });
    log.write("hello\n");
    log.line("started");
    expect(log.currentPath()).toBe(path.join(logDir, "gateway-20261029.log"));
    now = new Date(2026, 9, 30, 0, 0, 1);
    log.write("next day\n");
    expect(log.currentPath()).toBe(path.join(logDir, "gateway-20261030.log"));
    log.close();
    await new Promise((r) => setTimeout(r, 50));

    const names = (await fs.readdir(logDir)).toSorted();
    const daily = names.filter((n) => /^gateway-\d{8}\.log$/.test(n));
    expect(daily).toHaveLength(14);
    expect(daily).not.toContain("gateway-20261001.log");
    expect(daily).not.toContain("gateway-20261002.log");
    expect(daily).not.toContain("gateway-20261003.log");
    expect(daily).toContain("gateway-20261029.log");
    expect(daily).toContain("gateway-20261030.log");
    expect(names).toContain("gateway-exits.log");
    const today = await fs.readFile(path.join(logDir, "gateway-20261029.log"), "utf8");
    expect(today).toContain("hello\n");
    expect(today).toMatch(/\[supervisor\] started\n/);
  });

  it("removes an orchestrator socket only when nothing holds it", async () => {
    const sock = path.join(home, "orchestrator.sock");
    await fs.writeFile(sock, "");
    expect(await removeStaleOrchestratorSocket(sock, { probe: async () => "open" })).toBe(false);
    await expect(fs.access(sock)).resolves.toBeUndefined();
    expect(await removeStaleOrchestratorSocket(sock, { probe: async () => "refused" })).toBe(true);
    await expect(fs.access(sock)).rejects.toThrow();
    expect(await removeStaleOrchestratorSocket(sock, { probe: async () => "refused" })).toBe(false);
  });
});
