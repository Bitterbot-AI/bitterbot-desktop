/**
 * The tarball boot watchdog (PLAN-56 Phase 3b): decision table, and an end
 * to end run in respawn mode where the new version's launcher exits at once
 * (a broken release) and the watchdog switches `current` back, re-arms the
 * beacon for the old version, records the rollback and relaunches. State,
 * HOME and the app dir are temp directories.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeVersionDir } from "../test-utils/fake-tarball-release.js";
import { armBootVerify, readBootVerify, readRollbackRecord } from "./boot-verify.js";
import { tarballPlatformId } from "./install-kind.js";
import { readVersionLink, swapVersionLink } from "./tarball-install.js";
import { decideTarballWatchdogAction, runTarballWatchdog } from "./tarball-watchdog.js";

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
