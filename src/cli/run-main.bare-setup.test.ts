import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const onboardCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const onboardingCompleteMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./route.js", () => ({ tryRouteCli: vi.fn(async () => false) }));
vi.mock("../infra/dotenv.js", () => ({ loadDotEnv: vi.fn() }));
vi.mock("../infra/path-env.js", () => ({ ensureBitterbotCliOnPath: vi.fn() }));
vi.mock("../infra/runtime-guard.js", () => ({ assertSupportedRuntime: vi.fn() }));
vi.mock("../infra/unhandled-rejections.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/unhandled-rejections.js")>()),
  installUnhandledRejectionHandler: vi.fn(),
}));
vi.mock("./program/config-guard.js", () => ({ ensureConfigReady: vi.fn(async () => {}) }));
vi.mock("../commands/onboard.js", () => ({ onboardCommand: onboardCommandMock }));
vi.mock("../wizard/onboarding.first-boot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/onboarding.first-boot.js")>()),
  onboardingComplete: onboardingCompleteMock,
}));
vi.mock("../logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging.js")>()),
  enableConsoleCapture: vi.fn(),
}));

const { runCli } = await import("./run-main.js");
const { BARE_COMMAND_SETUP_NOTICE } = await import("./bare-command-setup.js");

describe("runCli: bare `bitterbot` on a fresh machine", () => {
  const saved = {
    argv: process.argv,
    stdinTty: process.stdin.isTTY,
    stdoutTty: process.stdout.isTTY,
    env: { ...process.env },
  };
  let stateDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-bare-setup-"));
    process.env.BITTERBOT_STATE_DIR = stateDir;
    process.env.BITTERBOT_CONFIG_PATH = path.join(stateDir, "bitterbot.json");
    process.env.BITTERBOT_HIDE_BANNER = "1";
    delete process.env.CI;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    process.argv = saved.argv;
    process.env = { ...saved.env };
    Object.defineProperty(process.stdin, "isTTY", { value: saved.stdinTty, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: saved.stdoutTty, configurable: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("prints one line and runs the onboard command with its defaults", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    onboardingCompleteMock.mockResolvedValueOnce(false);

    await runCli(["node", "bitterbot"], { rawArgv: ["node", "bitterbot"] });

    expect(logSpy).toHaveBeenCalledWith(BARE_COMMAND_SETUP_NOTICE);
    expect(onboardCommandMock).toHaveBeenCalledTimes(1);
    const [opts] = onboardCommandMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(opts.nonInteractive).toBe(false);
    expect(opts.fromInstaller).toBe(false);
    expect(process.argv.slice(2)).toEqual(["onboard"]);
    logSpy.mockRestore();
  });

  it("with --profile typed (stripped by the entry), prints help instead of setup", async () => {
    let written = "";
    const capture = ((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as typeof process.exit);

    await runCli(["node", "bitterbot"], {
      rawArgv: ["node", "bitterbot", "--profile", "work"],
    }).catch(() => {});

    expect(onboardingCompleteMock).not.toHaveBeenCalled();
    expect(onboardCommandMock).not.toHaveBeenCalled();
    expect(written).toContain("Usage:");
    writeSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
