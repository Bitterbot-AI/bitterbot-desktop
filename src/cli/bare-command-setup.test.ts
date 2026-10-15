import { describe, expect, it, vi } from "vitest";
import {
  BARE_COMMAND_SETUP_NOTICE,
  isBareInteractiveInvocation,
  resolveBareCommandArgv,
  shouldStartSetupForBareCommand,
} from "./bare-command-setup.js";

const BARE = ["node", "bitterbot"];

function ctx(overrides: Partial<Parameters<typeof shouldStartSetupForBareCommand>[0]> = {}) {
  return {
    argv: BARE,
    env: {},
    stdinIsTty: true,
    stdoutIsTty: true,
    isSetUp: vi.fn(async () => false),
    ...overrides,
  };
}

describe("shouldStartSetupForBareCommand", () => {
  it("fresh machine + interactive terminal + no args: start setup", async () => {
    expect(await shouldStartSetupForBareCommand(ctx())).toBe(true);
  });

  it.each([
    [["--help"]],
    [["-h"]],
    [["--version"]],
    [["-V"]],
    [["-v"]],
    [["status"]],
    [["onboard"]],
    [["--no-color"]],
    [["--verbose"]],
  ])("any argument keeps help: %j", async (args) => {
    const params = ctx({ argv: [...BARE, ...args] });
    expect(await shouldStartSetupForBareCommand(params)).toBe(false);
    expect(params.isSetUp).not.toHaveBeenCalled();
  });

  it.each([[["--dev"]], [["--profile", "work"]], [["--profile=work"]]])(
    "a profile flag the entry stripped still counts as an argument: %j",
    async (args) => {
      const params = ctx({ argv: BARE, rawArgv: [...BARE, ...args] });
      expect(await shouldStartSetupForBareCommand(params)).toBe(false);
      expect(params.isSetUp).not.toHaveBeenCalled();
    },
  );

  it("stdin not a TTY keeps help", async () => {
    const params = ctx({ stdinIsTty: false });
    expect(await shouldStartSetupForBareCommand(params)).toBe(false);
    expect(params.isSetUp).not.toHaveBeenCalled();
  });

  it("stdout not a TTY (piped) keeps help", async () => {
    expect(await shouldStartSetupForBareCommand(ctx({ stdoutIsTty: false }))).toBe(false);
  });

  it.each(["true", "1", "github-actions"])("CI=%s keeps help", async (value) => {
    const params = ctx({ env: { CI: value } });
    expect(await shouldStartSetupForBareCommand(params)).toBe(false);
    expect(params.isSetUp).not.toHaveBeenCalled();
  });

  it.each(["false", "0", ""])(
    "CI=%j (explicitly off or empty) does not block setup",
    async (value) => {
      expect(await shouldStartSetupForBareCommand(ctx({ env: { CI: value } }))).toBe(true);
    },
  );

  it("already set up keeps help", async () => {
    const params = ctx({ isSetUp: vi.fn(async () => true) });
    expect(await shouldStartSetupForBareCommand(params)).toBe(false);
    expect(params.isSetUp).toHaveBeenCalledTimes(1);
  });

  it("an error reading setup state keeps help", async () => {
    const params = ctx({
      isSetUp: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    expect(await shouldStartSetupForBareCommand(params)).toBe(false);
  });

  it("isBareInteractiveInvocation needs no disk access", () => {
    expect(
      isBareInteractiveInvocation({ argv: BARE, env: {}, stdinIsTty: true, stdoutIsTty: true }),
    ).toBe(true);
  });
});

describe("resolveBareCommandArgv", () => {
  it("fresh machine: prints one line and rewrites to onboard", async () => {
    const log = vi.fn();
    const out = await resolveBareCommandArgv(BARE, {
      env: {},
      stdinIsTty: true,
      stdoutIsTty: true,
      isSetUp: async () => false,
      log,
    });
    expect(out).toEqual(["node", "bitterbot", "onboard"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(BARE_COMMAND_SETUP_NOTICE);
  });

  it("already set up: argv unchanged (help), nothing printed", async () => {
    const log = vi.fn();
    const out = await resolveBareCommandArgv(BARE, {
      env: {},
      stdinIsTty: true,
      stdoutIsTty: true,
      isSetUp: async () => true,
      log,
    });
    expect(out).toBe(BARE);
    expect(log).not.toHaveBeenCalled();
  });

  it("with arguments: argv unchanged", async () => {
    const argv = [...BARE, "--help"];
    const isSetUp = vi.fn(async () => false);
    const out = await resolveBareCommandArgv(argv, {
      env: {},
      stdinIsTty: true,
      stdoutIsTty: true,
      isSetUp,
      log: vi.fn(),
    });
    expect(out).toBe(argv);
    expect(isSetUp).not.toHaveBeenCalled();
  });
});
