import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAndMaybeMigrateDoctorConfigMock = vi.hoisted(() => vi.fn());
const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: loadAndMaybeMigrateDoctorConfigMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

function makeSnapshot() {
  return {
    exists: false,
    valid: true,
    issues: [],
    legacyIssues: [],
    path: "/tmp/bitterbot.json",
  };
}

function makeRuntime() {
  return {
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("ensureConfigReady", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue(makeSnapshot());
  });

  it("skips doctor flow for read-only fast path commands", async () => {
    vi.resetModules();
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: makeRuntime() as never, commandPath: ["status"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).not.toHaveBeenCalled();
  });

  it("runs doctor flow for commands that may mutate state", async () => {
    vi.resetModules();
    const { ensureConfigReady } = await import("./config-guard.js");
    await ensureConfigReady({ runtime: makeRuntime() as never, commandPath: ["message"] });
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledTimes(1);
  });

  it("passes the installer's quiet modes to the config check", async () => {
    vi.resetModules();
    const { ensureConfigReady, configGuardOutput } = await import("./config-guard.js");
    expect(configGuardOutput({})).toBe("guard");
    expect(configGuardOutput({ BITTERBOT_INSTALLER: "1" })).toBe("summary");
    expect(configGuardOutput({ BITTERBOT_INSTALLER: "quiet" })).toBe("silent");
    const saved = process.env.BITTERBOT_INSTALLER;
    process.env.BITTERBOT_INSTALLER = "quiet";
    try {
      await ensureConfigReady({
        runtime: { ...makeRuntime(), log: vi.fn() } as never,
        commandPath: ["gateway", "switch"],
      });
    } finally {
      if (saved === undefined) {
        delete process.env.BITTERBOT_INSTALLER;
      } else {
        process.env.BITTERBOT_INSTALLER = saved;
      }
    }
    expect(loadAndMaybeMigrateDoctorConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ output: "silent" }),
    );
  });
});
