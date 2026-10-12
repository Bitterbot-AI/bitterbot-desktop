/**
 * The tarball boot watchdog (PLAN-56 Phase 3b): decision table, and an end
 * to end run in respawn mode where the new version's launcher exits at once
 * (a broken release) and the watchdog switches `current` back, re-arms the
 * beacon for the old version, records the rollback and relaunches. State,
 * HOME and the app dir are temp directories.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeVersionDir } from "../test-utils/fake-tarball-release.js";
import { armBootVerify, readBootVerify, readRollbackRecord } from "./boot-verify.js";
import { tarballPlatformId } from "./install-kind.js";
import { readVersionLink, swapVersionLink, versionInUse } from "./tarball-install.js";
import {
  decideTarballWatchdogAction,
  performTarballRollback,
  runTarballWatchdog,
  stopGatewayChild,
  withVersionPidMarker,
} from "./tarball-watchdog.js";
import { createUpdateSnapshot } from "./update-snapshot.js";

const NOW = 1_750_000_000_000;
const MIN = 60_000;

describe("decideTarballWatchdogAction", () => {
  const beacon = { prevSha: null, armedAt: NOW, deadlineAt: NOW + 5 * MIN };
  it("healthy, superseded and already-attempted stand down", () => {
    expect(
      decideTarballWatchdogAction({
        beacon: null,
        expectedArmedAt: NOW,
        now: NOW,
        childExited: true,
      }),
    ).toBe("exit-healthy");
    expect(
      decideTarballWatchdogAction({
        beacon: { ...beacon, armedAt: NOW + 1 },
        expectedArmedAt: NOW,
        now: NOW,
        childExited: true,
      }),
    ).toBe("exit-superseded");
    expect(
      decideTarballWatchdogAction({
        beacon: { ...beacon, rollbackAttempted: true },
        expectedArmedAt: NOW,
        now: NOW + 60 * MIN,
        childExited: true,
      }),
    ).toBe("exit-already-attempted");
  });
  it("a respawned gateway that exits before confirming triggers the rollback at once", () => {
    expect(
      decideTarballWatchdogAction({
        beacon,
        expectedArmedAt: NOW,
        now: NOW + 1,
        childExited: true,
      }),
    ).toBe("rollback");
  });
  it("otherwise waits until the deadline plus a grace period", () => {
    expect(
      decideTarballWatchdogAction({
        beacon,
        expectedArmedAt: NOW,
        now: NOW + 5 * MIN,
        childExited: false,
      }),
    ).toBe("wait");
    expect(
      decideTarballWatchdogAction({
        beacon,
        expectedArmedAt: NOW,
        now: NOW + 7 * MIN,
        childExited: false,
      }),
    ).toBe("rollback");
  });
});

const platformId = tarballPlatformId();
const describeE2e = process.platform !== "win32" && platformId ? describe : describe.skip;

describeE2e("runTarballWatchdog (respawn mode, broken new version)", () => {
  let work: string;
  let appDir: string;
  let stateDir: string;
  let prevState: string | undefined;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-watchdog-"));
    appDir = path.join(work, "app");
    stateDir = path.join(work, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    prevState = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;
    writeVersionDir(path.join(appDir, "1.4.0"), "1.4.0", platformId!);
    writeVersionDir(path.join(appDir, "1.5.0"), "1.5.0", platformId!);
    // The broken release: its launcher exits 1 immediately.
    fs.writeFileSync(path.join(appDir, "1.5.0", "bin", "bitterbot"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    // The good one records that it was relaunched with the gateway argv.
    fs.writeFileSync(
      path.join(appDir, "1.4.0", "bin", "bitterbot"),
      `#!/bin/sh\necho "$@" > "${path.join(work, "relaunched.txt")}"\n`,
      { mode: 0o755 },
    );
    swapVersionLink(appDir, "previous", "1.4.0");
    swapVersionLink(appDir, "current", "1.5.0");
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prevState;
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("switches back, re-arms for the old version, records the rollback and relaunches", async () => {
    const beacon = armBootVerify({
      prevSha: null,
      expectedVersion: "1.5.0",
      deadlineMs: 5 * MIN,
      tarball: {
        appDir,
        fromVersion: "1.4.0",
        toVersion: "1.5.0",
        restart: "respawn",
        snapshotDir: null,
        fromMemorySchemaLatest: 78,
        autoRollback: true,
      },
    })!;
    await runTarballWatchdog({
      root: path.join(appDir, "1.4.0"),
      expectedArmedAt: beacon.armedAt,
      respawnArgv: ["gateway", "--allow-unconfigured"],
    });
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
    expect(readVersionLink(appDir, "previous")).toBe("1.5.0");
    const record = readRollbackRecord();
    expect(record).toMatchObject({
      mode: "tarball",
      ok: true,
      fromVersion: "1.5.0",
      toVersion: "1.4.0",
    });
    const rearmed = readBootVerify();
    expect(rearmed?.expectedVersion).toBe("1.4.0");
    expect(rearmed?.rollbackAttempted).toBe(true);
    // The old version was launched with the gateway's argv.
    for (let i = 0; i < 50 && !fs.existsSync(path.join(work, "relaunched.txt")); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(fs.readFileSync(path.join(work, "relaunched.txt"), "utf8").trim()).toBe(
      "gateway --allow-unconfigured",
    );
  });

  it("with update.autoRollback.enabled false it leaves current alone", async () => {
    const beacon = armBootVerify({
      prevSha: null,
      expectedVersion: "1.5.0",
      tarball: {
        appDir,
        fromVersion: "1.4.0",
        toVersion: "1.5.0",
        restart: "respawn",
        snapshotDir: null,
        fromMemorySchemaLatest: 78,
        autoRollback: false,
      },
    })!;
    await runTarballWatchdog({
      root: path.join(appDir, "1.4.0"),
      expectedArmedAt: beacon.armedAt,
      respawnArgv: ["gateway"],
    });
    expect(readVersionLink(appDir, "current")).toBe("1.5.0");
    expect(readRollbackRecord()).toBeNull();
    expect(readBootVerify()?.armedAt).toBe(beacon.armedAt);
  });
});

const describePosix = process.platform !== "win32" ? describe : describe.skip;

describePosix("stopGatewayChild", () => {
  it("kills the launched gateway's whole process group, not just the launcher", async () => {
    // A launcher that ignores SIGTERM and runs an inner "gateway" (which
    // inherits the ignored SIGTERM): a hung gateway.
    const child = spawn("sh", ["-c", 'trap "" TERM; sleep 60 & echo $!; wait'], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const inner = await new Promise<number>((resolve) =>
      child.stdout!.once("data", (d: Buffer) => resolve(Number.parseInt(String(d).trim(), 10))),
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive(inner)).toBe(true);
      expect(await stopGatewayChild(child, { termTimeoutMs: 300, killTimeoutMs: 5_000 })).toBe(
        true,
      );
      expect(alive(inner)).toBe(false);
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
});

describePosix("withVersionPidMarker", () => {
  it("marks the version directory in use while the watchdog runs, and cleans up", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-watchdog-marker-"));
    try {
      const during = await withVersionPidMarker(root, async () =>
        versionInUse(root, { excludePids: [], procRoot: null }),
      );
      expect(during).toBe(process.pid);
      expect(versionInUse(root, { excludePids: [], procRoot: null })).toBeNull();
      expect(fs.readdirSync(path.join(root, ".pids"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describeE2e("performTarballRollback (a database to restore)", () => {
  let work: string;
  let appDir: string;
  let stateDir: string;
  let prevState: string | undefined;
  const db = () => path.join(stateDir, "memory", "main.sqlite");

  function makeDb(rows: number, schema: number) {
    fs.mkdirSync(path.dirname(db()), { recursive: true });
    const d = new DatabaseSync(db());
    d.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    d.exec("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, text TEXT)");
    d.prepare(
      "INSERT INTO meta VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(schema));
    for (let i = 0; i < rows; i += 1) {
      d.prepare("INSERT INTO chunks (text) VALUES (?)").run(`m${i}`);
    }
    d.close();
  }
  function rows(): number {
    const d = new DatabaseSync(db(), { readOnly: true });
    try {
      return (d.prepare("SELECT count(*) AS n FROM chunks").get() as { n: number }).n;
    } finally {
      d.close();
    }
  }

  beforeEach(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-rb-"));
    appDir = path.join(work, "app");
    stateDir = path.join(work, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    prevState = process.env.BITTERBOT_STATE_DIR;
    process.env.BITTERBOT_STATE_DIR = stateDir;
    writeVersionDir(path.join(appDir, "1.4.0"), "1.4.0", platformId!);
    writeVersionDir(path.join(appDir, "1.5.0"), "1.5.0", platformId!);
    swapVersionLink(appDir, "previous", "1.4.0");
    swapVersionLink(appDir, "current", "1.5.0");
    makeDb(3, 70);
    await createUpdateSnapshot({
      sources: {
        stateDir,
        configPath: path.join(stateDir, "bitterbot.json"),
        workspaceDir: null,
        keyDir: null,
      },
      from: "1.4.0",
      to: "1.5.0",
      fromMemorySchemaLatest: 70,
    });
    // The new version migrated past what 1.4.0 knows, then failed to boot.
    makeDb(1, 80);
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.BITTERBOT_STATE_DIR;
    else process.env.BITTERBOT_STATE_DIR = prevState;
    fs.rmSync(work, { recursive: true, force: true });
  });

  const tarball = () => ({
    appDir,
    fromVersion: "1.4.0",
    toVersion: "1.5.0",
    restart: "service" as const,
    snapshotDir: null,
    fromMemorySchemaLatest: 70,
    autoRollback: true,
  });

  it("service mode: a failed `gateway stop` and a gateway still answering keep the database", async () => {
    const calls: Array<{ pgid: number | null }> = [];
    const res = await performTarballRollback({
      tarball: tarball(),
      watchdogRoot: path.join(appDir, "1.4.0"),
      respawnArgv: null,
      child: null,
      stateDir,
      runCommand: async (argv) => ({ stdout: "", stderr: "", code: argv.includes("stop") ? 1 : 0 }),
      gatewayCheck: async (p) => {
        calls.push(p);
        return { gone: false, detail: "port 19001 on 127.0.0.1 accepts connections" };
      },
    });
    expect(calls).toEqual([{ pgid: null }]);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
    expect(res.databasesSkipped).toMatch(/19001/);
    expect(res.detail).toMatch(/databases NOT restored/);
    expect(res.restored).toEqual([]);
    // The live database was not renamed away.
    expect(rows()).toBe(4);
  });

  it("restores it once the gateway is confirmed gone", async () => {
    const res = await performTarballRollback({
      tarball: tarball(),
      watchdogRoot: path.join(appDir, "1.4.0"),
      respawnArgv: null,
      child: null,
      stateDir,
      runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
      gatewayCheck: async () => ({ gone: true, detail: "" }),
    });
    expect(res.databasesSkipped).toBeNull();
    expect(res.restored).toContain(db());
    expect(rows()).toBe(3);
  });

  it("respawn mode checks the launched gateway's process group", async () => {
    const calls: Array<{ pgid: number | null }> = [];
    await performTarballRollback({
      tarball: { ...tarball(), restart: "respawn" },
      watchdogRoot: path.join(appDir, "1.4.0"),
      respawnArgv: ["gateway"],
      child: { pid: 4242 } as unknown as ChildProcess,
      stateDir,
      stopChild: async () => false,
      launch: () => null,
      gatewayCheck: async (p) => {
        calls.push(p);
        return { gone: false, detail: "process group 4242 of the launched gateway is still alive" };
      },
    });
    expect(calls).toEqual([{ pgid: 4242 }]);
    expect(rows()).toBe(4);
  });
});
