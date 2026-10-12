/**
 * `bitterbot update` for a release-tarball install (PLAN-56 Phase 3b),
 * driven against fake signed releases in test mode: --check, update with
 * JSON output, the stable-only channel, test-mode refusals, --rollback, and
 * the boot-verdict wait. HOME/state/app dirs are temp; the gateway service
 * and RPC are mocked (no gateway is running).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../daemon-cli.js", () => ({ runDaemonRestart: vi.fn(async () => false) }));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    isLoaded: async () => false,
    stop: async () => {},
    restart: async () => {},
  }),
}));
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => {
    throw new Error("no gateway");
  }),
}));

import { armBootVerify, confirmBootHealthy, writeRollbackRecord } from "../../infra/boot-verify.js";
import { tarballPlatformId } from "../../infra/install-kind.js";
import { readVersionLink, swapVersionLink } from "../../infra/tarball-install.js";
import { captureFullEnv } from "../../test-utils/env.js";
import { publishFakeRelease, writeVersionDir } from "../../test-utils/fake-tarball-release.js";
import { makeTestMinisignKey } from "../../test-utils/minisign.js";
import { runTarballUpdateCommand, waitForTarballBoot } from "./tarball.js";

const platformId = tarballPlatformId();
const describeCli = process.platform !== "win32" && platformId ? describe : describe.skip;
const envSnapshot = captureFullEnv();

function jsonOutput(): Record<string, unknown> {
  const line = runtime.log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith("{"));
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describeCli("runTarballUpdateCommand", () => {
  let work: string;
  let appDir: string;
  let releases: string;
  const key = makeTestMinisignKey();

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-cli-"));
    const home = path.join(work, "home");
    const stateDir = path.join(home, ".bitterbot");
    appDir = path.join(stateDir, "app");
    releases = path.join(work, "releases");
    fs.mkdirSync(releases, { recursive: true });
    writeVersionDir(path.join(appDir, "1.4.0"), "1.4.0", platformId!);
    swapVersionLink(appDir, "current", "1.4.0");
    publishFakeRelease({ releases, work, version: "1.5.0", platformId: platformId!, key });
    process.env.HOME = home;
    process.env.BITTERBOT_STATE_DIR = stateDir;
    delete process.env.BITTERBOT_CONFIG_PATH;
    process.env.BITTERBOT_INSTALL_KIND = "tarball";
    process.env.BITTERBOT_INSTALL_ROOT = path.join(appDir, "1.4.0");
    process.env.BITTERBOT_INSTALL_TEST_MODE = "1";
    process.env.BITTERBOT_INSTALL_BASE_URL = pathToFileURL(releases).href;
    process.env.BITTERBOT_INSTALL_TEST_PUBKEY = key.pubkeyB64;
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
  });

  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("--check reports the newer release and changes nothing", async () => {
    await runTarballUpdateCommand({
      root: path.join(appDir, "1.4.0"),
      opts: { check: true, json: true },
    });
    expect(jsonOutput()).toMatchObject({
      installKind: "tarball",
      current: "1.4.0",
      target: "1.5.0",
      status: "checked",
      updateAvailable: true,
    });
    expect(runtime.exit).toHaveBeenCalledWith(0);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
  });

  it("updates, reports JSON, and says how to start the gateway when none runs", async () => {
    await runTarballUpdateCommand({
      root: path.join(appDir, "1.4.0"),
      opts: { json: true, yes: true },
    });
    const out = jsonOutput();
    expect(out).toMatchObject({ status: "ok", current: "1.4.0", target: "1.5.0" });
    expect((out.result as { to: string }).to).toBe("1.5.0");
    expect((out.restart as { kind: string }).kind).toBe("none");
    expect(readVersionLink(appDir, "current")).toBe("1.5.0");
    expect(readVersionLink(appDir, "previous")).toBe("1.4.0");
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("is a no-op on the newest release", async () => {
    await runTarballUpdateCommand({ root: path.join(appDir, "1.4.0"), opts: { json: true } });
    runtime.log.mockReset();
    process.env.BITTERBOT_INSTALL_ROOT = path.join(appDir, "1.5.0");
    await runTarballUpdateCommand({ root: path.join(appDir, "1.5.0"), opts: { json: true } });
    expect(jsonOutput()).toMatchObject({ status: "skipped", reason: "up-to-date" });
  });

  it("follows stable only", async () => {
    await runTarballUpdateCommand({ root: path.join(appDir, "1.4.0"), opts: { channel: "beta" } });
    expect(runtime.error.mock.calls.join("\n")).toContain("stable channel");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
  });

  it("refuses the test-mode overrides without BITTERBOT_INSTALL_TEST_MODE=1", async () => {
    delete process.env.BITTERBOT_INSTALL_TEST_MODE;
    await runTarballUpdateCommand({ root: path.join(appDir, "1.4.0"), opts: { yes: true } });
    expect(runtime.error.mock.calls.join("\n")).toContain("need BITTERBOT_INSTALL_TEST_MODE=1");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
  });

  it("--rollback switches back to previous", async () => {
    await runTarballUpdateCommand({ root: path.join(appDir, "1.4.0"), opts: { json: true } });
    runtime.log.mockReset();
    process.env.BITTERBOT_INSTALL_ROOT = path.join(appDir, "1.5.0");
    await runTarballUpdateCommand({
      root: path.join(appDir, "1.5.0"),
      opts: { rollback: true, yes: true, json: true },
    });
    expect(jsonOutput()).toMatchObject({
      status: "ok",
      rollback: { from: "1.5.0", to: "1.4.0" },
    });
    expect(readVersionLink(appDir, "current")).toBe("1.4.0");
    expect(readVersionLink(appDir, "previous")).toBe("1.5.0");
  });

  it("--rollback without a previous version is refused", async () => {
    await runTarballUpdateCommand({
      root: path.join(appDir, "1.4.0"),
      opts: { rollback: true, yes: true },
    });
    expect(runtime.error.mock.calls.join("\n")).toContain("no previous version");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

describe("waitForTarballBoot", () => {
  let work: string;
  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "bb-tarball-wait-"));
    process.env.BITTERBOT_STATE_DIR = work;
  });
  afterEach(() => {
    envSnapshot.restore();
    fs.rmSync(work, { recursive: true, force: true });
  });

  function arm() {
    return armBootVerify({ prevSha: null, expectedVersion: "1.5.0", deadlineMs: 5 * 60_000 })!;
  }

  it("healthy when the new version clears the beacon", async () => {
    const beacon = arm();
    const outcome = await waitForTarballBoot({
      beacon,
      toVersion: "1.5.0",
      fromVersion: "1.4.0",
      sleep: async () => confirmBootHealthy("1.5.0"),
    });
    expect(outcome).toEqual({ status: "healthy", version: "1.5.0" });
  });

  it("rolled back when the watchdog recorded a rollback and the old version came up", async () => {
    const beacon = arm();
    writeRollbackRecord({
      fromSha: null,
      toSha: "v1.4.0",
      mode: "tarball",
      fromVersion: "1.5.0",
      toVersion: "1.4.0",
      at: beacon.armedAt + 1,
      detail: "current -> 1.4.0",
      ok: true,
    });
    armBootVerify({ prevSha: null, expectedVersion: "1.4.0", rollbackAttempted: true });
    const outcome = await waitForTarballBoot({
      beacon,
      toVersion: "1.5.0",
      fromVersion: "1.4.0",
      sleep: async () => confirmBootHealthy("1.4.0"),
    });
    expect(outcome).toMatchObject({ status: "rolled-back", version: "1.4.0", healthy: true });
  });

  it("reports a failed rollback", async () => {
    const beacon = arm();
    writeRollbackRecord({
      fromSha: null,
      toSha: "v1.4.0",
      mode: "tarball",
      at: beacon.armedAt + 1,
      detail: "switching back FAILED",
      ok: false,
    });
    const outcome = await waitForTarballBoot({ beacon, toVersion: "1.5.0", fromVersion: "1.4.0" });
    expect(outcome).toMatchObject({ status: "rollback-failed" });
  });

  it("times out after the deadline plus slack", async () => {
    const beacon = arm();
    let t = beacon.armedAt;
    const outcome = await waitForTarballBoot({
      beacon,
      toVersion: "1.5.0",
      fromVersion: "1.4.0",
      now: () => t,
      sleep: async () => {
        t += 60_000;
      },
    });
    expect(outcome.status).toBe("timeout");
  });
});
