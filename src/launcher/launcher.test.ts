/**
 * The npm launcher against fake signed releases on disk (the same fixtures
 * as the in-place updater tests): first-run install, catch-up after an npm
 * update, running a newer in-place-updated app, the offline fallback, every
 * verification refusal, the shared lock, and an unsupported platform. HOME
 * and the app dir are temp directories; spawn is mocked, so nothing runs.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tarballPlatformId } from "../infra/install-kind.js";
import { readVersionLink, swapVersionLink } from "../infra/tarball-install.js";
import { UPDATE_LOCK_FILE } from "../infra/tarball-lock.js";
import {
  publishFakeRelease,
  writeReleasesApi,
  writeVersionDir,
} from "../test-utils/fake-tarball-release.js";
import { makeTestMinisignKey, type TestMinisignKey } from "../test-utils/minisign.js";
import {
  decideLaunch,
  ownershipProblem,
  resolveAppDir,
  runLauncher,
  shouldShowUpgradeHint,
  type LauncherDeps,
} from "./launcher.js";
import type { PlatformProbe } from "./platform.js";
import type { LauncherOutput } from "./progress.js";

const hostPlatformId = tarballPlatformId();
const describeHost = process.platform !== "win32" && hostPlatformId ? describe : describe.skip;

describe("decideLaunch", () => {
  it("installs only when nothing usable is installed", () => {
    expect(decideLaunch({ current: null, currentRunnable: false, target: "1.6.2" })).toEqual({
      action: "install",
    });
    expect(decideLaunch({ current: "1.6.1", currentRunnable: false, target: "1.6.2" })).toEqual({
      action: "install",
    });
  });

  it("runs an older installed app and only notes the newer launcher version (no forced upgrade)", () => {
    expect(decideLaunch({ current: "1.6.1", currentRunnable: true, target: "1.6.2" })).toEqual({
      action: "run",
      version: "1.6.1",
      newer: "1.6.2",
    });
    expect(decideLaunch({ current: "1.9.0", currentRunnable: true, target: "1.10.0" })).toEqual({
      action: "run",
      version: "1.9.0",
      newer: "1.10.0",
    });
  });

  it("runs an app that is the same or newer (`bitterbot update` updated it in place)", () => {
    expect(decideLaunch({ current: "1.6.2", currentRunnable: true, target: "1.6.2" })).toEqual({
      action: "run",
      version: "1.6.2",
      newer: null,
    });
    expect(decideLaunch({ current: "1.10.0", currentRunnable: true, target: "1.9.9" })).toEqual({
      action: "run",
      version: "1.10.0",
      newer: null,
    });
  });
});

describe("shouldShowUpgradeHint", () => {
  it("only for a person at a terminal, never for services, --version or JSON", () => {
    expect(shouldShowUpgradeHint(["status"], true)).toBe(true);
    expect(shouldShowUpgradeHint([], true)).toBe(true);
    expect(shouldShowUpgradeHint(["status"], false)).toBe(false);
    expect(shouldShowUpgradeHint(["gateway", "--port", "19001"], true)).toBe(false);
    expect(shouldShowUpgradeHint(["--version"], true)).toBe(false);
    expect(shouldShowUpgradeHint(["update", "status", "--json"], true)).toBe(false);
  });
});

describe("ownershipProblem", () => {
  it("refuses root unless BITTERBOT_ALLOW_ROOT=1, pointing at the no-sudo docs", () => {
    const msg = ownershipProblem({ appDir: "/nonexistent/app", env: {}, uid: 0 });
    expect(msg).toMatch(/refuses to run as root \(sudo\)/);
    expect(msg).toContain("docs/start/npm.md#eacces-permission-denied");
    expect(
      ownershipProblem({ appDir: "/nonexistent/app", env: { BITTERBOT_ALLOW_ROOT: "1" }, uid: 0 }),
    ).toBeNull();
    expect(ownershipProblem({ appDir: "/nonexistent/app", env: {}, uid: null })).toBeNull();
  });

  // Windows reports uid 0 for every file, and the launcher refuses Windows anyway.
  it.skipIf(process.platform === "win32")(
    "refuses an app dir (or its parent) owned by another user",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-owner-"));
      try {
        const appDir = path.join(dir, "app");
        const mine = fs.statSync(dir).uid;
        expect(ownershipProblem({ appDir, env: {}, uid: mine })).toBeNull();
        const msg = ownershipProblem({ appDir, env: {}, uid: mine + 4242 });
        expect(msg).toMatch(/belongs to another user/);
        expect(msg).toContain("sudo chown -R");
        expect(msg).toContain("eacces-permission-denied");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("resolveAppDir", () => {
  it("defaults to install.sh's ~/.bitterbot/app and honours BITTERBOT_APP_DIR", () => {
    expect(resolveAppDir({}, "/home/u")).toBe(path.join("/home/u", ".bitterbot", "app"));
    expect(resolveAppDir({ BITTERBOT_APP_DIR: "/opt/bb" }, "/home/u")).toBe(
      path.resolve("/opt/bb"),
    );
  });
});

type Captured = { lines: string[]; output: LauncherOutput };

function captureOutput(): Captured {
  const lines: string[] = [];
  return {
    lines,
    output: { say: (l) => lines.push(l), progress: () => {}, endProgress: () => {} },
  };
}

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };

function fakeSpawn(calls: SpawnCall[], exitCode = 0) {
  return (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env ?? {} });
    const child = new EventEmitter() as EventEmitter & { kill: (s?: string) => boolean };
    child.kill = () => true;
    setImmediate(() => child.emit("exit", exitCode, null));
    return child as never;
  };
}

const hostProbe: PlatformProbe = {
  platform: process.platform,
  arch: process.arch,
  glibcVersion: () => "2.35",
  isMusl: () => false,
  isRosetta: () => false,
};

describeHost("runLauncher", () => {
  let work: string;
  let home: string;
  let appDir: string;
  let releases: string;
  let key: TestMinisignKey;
  let calls: SpawnCall[];
  let out: Captured;

  beforeAll(() => {
    key = makeTestMinisignKey();
  });

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-launcher-"));
    home = path.join(work, "home");
    appDir = path.join(home, ".bitterbot", "app");
    releases = path.join(work, "releases");
    fs.mkdirSync(releases, { recursive: true });
    writeReleasesApi(releases);
    calls = [];
    out = captureOutput();
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function testEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      BITTERBOT_INSTALL_TEST_MODE: "1",
      BITTERBOT_INSTALL_BASE_URL: pathToFileURL(releases).href,
      BITTERBOT_INSTALL_TEST_PUBKEY: key.pubkeyB64,
      ...extra,
    };
  }

  function publish(version: string, opts = {}) {
    publishFakeRelease({ releases, work, version, platformId: hostPlatformId!, key, opts });
  }

  function installed(version: string) {
    writeVersionDir(path.join(appDir, version), version, hostPlatformId!);
    swapVersionLink(appDir, "current", version);
  }

  function launch(overrides: Partial<LauncherDeps> = {}) {
    return runLauncher({
      argv: ["gateway", "--port", "19001"],
      env: testEnv(),
      version: "1.6.2",
      homedir: home,
      probe: hostProbe,
      output: out.output,
      run: { spawn: fakeSpawn(calls) },
      procRoot: null,
      sleep: async () => {},
      interactive: false,
      launcherPath: "/npm/lib/node_modules/bitterbot/bitterbot.mjs",
      ...overrides,
    });
  }

  it("first run: verifies, installs like install.sh, then runs the app with the same argv", async () => {
    publish("1.6.2");
    expect(await launch()).toBe(0);
    expect(readVersionLink(appDir, "current")).toBe("1.6.2");
    expect(readVersionLink(appDir, "previous")).toBeNull();
    expect(fs.readFileSync(path.join(appDir, "1.6.2", ".bitterbot-install-kind"), "utf8")).toBe(
      "tarball\n",
    );
    expect(fs.existsSync(path.join(appDir, UPDATE_LOCK_FILE))).toBe(false);
    expect(fs.readdirSync(appDir).filter((n) => n.startsWith(".update-"))).toEqual([]);
    expect(out.lines[0]).toMatch(/^Bitterbot 1\.6\.2: first run, downloading the signed release/);
    expect(out.lines.at(-1)).toBe("Verified and installed to ~/.bitterbot/app/1.6.2.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(path.join(appDir, "current", "bin", "bitterbot"));
    expect(calls[0]!.args).toEqual(["gateway", "--port", "19001"]);
    // The app (and doctor) can tell npm owns the `bitterbot` command.
    expect(calls[0]!.env.BITTERBOT_LAUNCHED_BY).toBe("npm");
    expect(calls[0]!.env.BITTERBOT_NPM_LAUNCHER).toBe(
      "/npm/lib/node_modules/bitterbot/bitterbot.mjs",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(appDir, ".npm-launcher.json"), "utf8")),
    ).toMatchObject({
      launcher: "/npm/lib/node_modules/bitterbot/bitterbot.mjs",
      version: "1.6.2",
    });
  });

  it("does not hand the app stale install-kind variables", async () => {
    installed("1.6.2");
    await launch({
      env: testEnv({
        BITTERBOT_INSTALL_KIND: "package",
        BITTERBOT_INSTALL_ROOT: "/old/npm/package",
        BITTERBOT_NODE_OPTIONS_READY: "1",
        KEEP_ME: "yes",
      }),
    });
    expect(calls[0]!.env.BITTERBOT_INSTALL_KIND).toBeUndefined();
    expect(calls[0]!.env.BITTERBOT_INSTALL_ROOT).toBeUndefined();
    expect(calls[0]!.env.BITTERBOT_NODE_OPTIONS_READY).toBeUndefined();
    expect(calls[0]!.env.KEEP_ME).toBe("yes");
  });

  it("runs an app that `bitterbot update` already moved past the launcher, with no download", async () => {
    installed("1.7.0");
    // No release is published: any download attempt would fail.
    expect(await launch()).toBe(0);
    expect(readVersionLink(appDir, "current")).toBe("1.7.0");
    expect(out.lines).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("never replaces an older installed app (a rollback sticks); hints only at a terminal", async () => {
    installed("1.6.1");
    publish("1.6.2");
    expect(await launch()).toBe(0);
    expect(readVersionLink(appDir, "current")).toBe("1.6.1");
    expect(fs.existsSync(path.join(appDir, "1.6.2"))).toBe(false);
    expect(out.lines).toEqual([]);
    expect(calls).toHaveLength(1);

    const hinted = captureOutput();
    expect(await launch({ interactive: true, argv: ["status"], output: hinted.output })).toBe(0);
    expect(hinted.lines).toEqual([
      "Bitterbot 1.6.2 is available (you have 1.6.1). Run `bitterbot update` to upgrade safely.",
    ]);
    expect(readVersionLink(appDir, "current")).toBe("1.6.1");

    // A gateway start (a service) never gets the hint, even at a terminal.
    const quiet = captureOutput();
    await launch({ interactive: true, output: quiet.output });
    expect(quiet.lines).toEqual([]);
  });

  it("propagates the app's exit code", async () => {
    installed("1.6.2");
    expect(await launch({ run: { spawn: fakeSpawn(calls, 3) } })).toBe(3);
  });

  it("offline with nothing installed: one clear message, exit 1, nothing run", async () => {
    const env = testEnv({ BITTERBOT_INSTALL_BASE_URL: "http://127.0.0.1:9" });
    expect(await launch({ env })).toBe(1);
    expect(out.lines.join("\n")).toMatch(
      /Could not download Bitterbot 1\.6\.2: .*\nCheck your internet connection/,
    );
    expect(out.lines.join("\n")).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
    expect(calls).toEqual([]);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a tampered tarball", { tamper: true }, /SHA-256 mismatch/],
    ["a missing signature", { noSig: true }, /no checksums\.txt\.minisig/],
    [
      "a signature replayed from another release",
      { comment: "v1.6.1 checksums" },
      /not 'v1\.6\.2 checksums'/,
    ],
  ];

  for (const [what, opts, reason] of refusals) {
    it(`refuses ${what} and installs nothing`, async () => {
      publish("1.6.2", opts);
      expect(await launch()).toBe(1);
      const text = out.lines.join("\n");
      expect(text).toMatch(/^Refusing to install Bitterbot 1\.6\.2: /m);
      expect(text).toMatch(reason);
      expect(readVersionLink(appDir, "current")).toBeNull();
      expect(fs.existsSync(path.join(appDir, "1.6.2"))).toBe(false);
      expect(calls).toEqual([]);
    });
  }

  it("refuses a release signed with another key", async () => {
    publish("1.6.2", { signer: makeTestMinisignKey() });
    expect(await launch()).toBe(1);
    expect(out.lines.join("\n")).toMatch(/Refusing to install .*signature check FAILED/s);
    expect(readVersionLink(appDir, "current")).toBeNull();
  });

  it("refuses the test overrides without test mode (production always uses GitHub and the pinned key)", async () => {
    publish("1.6.2");
    const env = testEnv();
    delete env.BITTERBOT_INSTALL_TEST_MODE;
    expect(await launch({ env })).toBe(1);
    expect(out.lines.join("\n")).toMatch(/need BITTERBOT_INSTALL_TEST_MODE=1/);
    expect(fs.existsSync(appDir)).toBe(false);
  });

  it("refuses a non-loopback download URL even in test mode", async () => {
    expect(
      await launch({ env: testEnv({ BITTERBOT_INSTALL_BASE_URL: "https://example.com/r" }) }),
    ).toBe(1);
    expect(out.lines.join("\n")).toMatch(/only accepts a loopback/);
  });

  it("an unpack failure for lack of space is reported calmly and activates nothing", async () => {
    publish("1.6.2");
    const runTar = vi.fn(async () => {
      throw Object.assign(new Error("write failed"), { code: "ENOSPC" });
    });
    expect(await launch({ runTar })).toBe(1);
    expect(out.lines.join("\n")).toMatch(/not enough free disk space .*\nFree some space/);
    expect(readVersionLink(appDir, "current")).toBeNull();
    expect(fs.readdirSync(appDir).filter((n) => n.startsWith(".update-"))).toEqual([]);
  });

  it("a platform without a tarball in this release says so", async () => {
    publish("1.6.2");
    // Re-sign checksums.txt without this platform's entry.
    const dir = path.join(releases, "download", "v1.6.2");
    const { signTestMinisign } = await import("../test-utils/minisign.js");
    const checksums = `${"0".repeat(64)}  install.sh\n`;
    fs.writeFileSync(path.join(dir, "checksums.txt"), checksums);
    fs.writeFileSync(
      path.join(dir, "checksums.txt.minisig"),
      signTestMinisign(key, checksums, "v1.6.2 checksums"),
    );
    expect(await launch()).toBe(1);
    expect(out.lines.join("\n")).toMatch(/has no release build for .* yet/);
  });

  it("a release that is not on GitHub yet says so (not a platform problem)", async () => {
    expect(await launch()).toBe(1);
    expect(out.lines.join("\n")).toMatch(/Bitterbot 1\.6\.2 was not found on GitHub Releases yet/);
  });

  it("refuses to run as root, before touching anything", async () => {
    publish("1.6.2");
    expect(await launch({ uid: 0 })).toBe(1);
    expect(out.lines.join("\n")).toMatch(/refuses to run as root/);
    expect(fs.existsSync(appDir)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("waits for another install holding the lock, then runs what it installed", async () => {
    fs.mkdirSync(appDir, { recursive: true });
    // A live process (our parent) holds the app-dir lock.
    fs.writeFileSync(
      path.join(appDir, UPDATE_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, token: "other", createdAt: Date.now(), startTime: null }),
    );
    let waits = 0;
    const sleep = async () => {
      waits += 1;
      // The other install finishes: version in place, lock released.
      installed("1.6.2");
      fs.rmSync(path.join(appDir, UPDATE_LOCK_FILE));
    };
    expect(await launch({ sleep })).toBe(0);
    expect(waits).toBe(1);
    expect(out.lines[0]).toMatch(/^Waiting for another Bitterbot install or update to finish/);
    // Nothing was downloaded (no release is published) and the app ran.
    expect(calls).toHaveLength(1);
  });

  it("gives up after the lock wait with a clear message", async () => {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, UPDATE_LOCK_FILE),
      JSON.stringify({ pid: process.ppid, token: "other", createdAt: Date.now(), startTime: null }),
    );
    expect(await launch({ lockWaitMs: -1 })).toBe(1);
    expect(out.lines.join("\n")).toMatch(/another Bitterbot install or update is still running/);
    expect(fs.existsSync(path.join(appDir, UPDATE_LOCK_FILE))).toBe(true);
  });

  it("two launchers at once install once", async () => {
    publish("1.6.2");
    const second = captureOutput();
    const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
    const [a, b] = await Promise.all([
      launch({ sleep: realSleep }),
      launch({ sleep: realSleep, output: second.output }),
    ]);
    expect([a, b]).toEqual([0, 0]);
    const installs = [...out.lines, ...second.lines].filter((l) =>
      l.startsWith("Verified and installed"),
    );
    expect(installs).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("an unsupported platform gets one message and no app dir", async () => {
    const probe: PlatformProbe = {
      ...hostProbe,
      platform: "linux",
      arch: "x64",
      isMusl: () => true,
    };
    expect(await launch({ probe })).toBe(1);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/musl-based Linux .*Use Docker: https:\/\//);
    expect(fs.existsSync(appDir)).toBe(false);
  });
});
