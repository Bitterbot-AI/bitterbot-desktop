import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 4321, unref: () => {}, on: () => {} })));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { spawnSetupGateway } from "../commands/onboard-browser.js";
import { installerOutputMode, withoutInstallerEnv } from "./installer-env.js";

describe("installer environment", () => {
  it("accepts only BITTERBOT_INSTALLER=1 and =quiet", () => {
    expect(installerOutputMode({ BITTERBOT_INSTALLER: "1" })).toBe("summary");
    expect(installerOutputMode({ BITTERBOT_INSTALLER: "quiet" })).toBe("silent");
    for (const value of ["true", "yes", "0", "QUIET", ""]) {
      expect(installerOutputMode({ BITTERBOT_INSTALLER: value })).toBeNull();
    }
    expect(installerOutputMode({})).toBeNull();
  });

  it("drops the installer's per-command variables and keeps everything else", () => {
    expect(
      withoutInstallerEnv({
        BITTERBOT_INSTALLER: "quiet",
        BITTERBOT_HIDE_BANNER: "1",
        BITTERBOT_INSTALL_TEST_MODE: "1",
        BITTERBOT_GATEWAY_TOKEN: "t",
        PATH: "/usr/bin",
      }),
    ).toEqual({ BITTERBOT_GATEWAY_TOKEN: "t", PATH: "/usr/bin" });
  });
});

describe("the setup gateway onboard starts", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-installer-env-"));
    for (const k of ["BITTERBOT_STATE_DIR", "BITTERBOT_INSTALLER", "BITTERBOT_HIDE_BANNER"]) {
      saved[k] = process.env[k];
    }
    process.env.BITTERBOT_STATE_DIR = dir;
    process.env.BITTERBOT_INSTALLER = "quiet";
    process.env.BITTERBOT_HIDE_BANNER = "1";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not inherit the installer's quiet-output variables", () => {
    spawnSetupGateway(19999);
    const calls = spawnMock.mock.calls as unknown as Array<
      [string, string[], { env: NodeJS.ProcessEnv }]
    >;
    const env = calls.at(-1)?.[2].env ?? {};
    expect(env.BITTERBOT_INSTALLER).toBeUndefined();
    expect(env.BITTERBOT_HIDE_BANNER).toBeUndefined();
    expect(env.BITTERBOT_STATE_DIR).toBe(dir);
  });
});
