/**
 * Bare `bitterbot` on a machine that is not set up yet starts setup.
 *
 * A new user who ran `npm install -g bitterbot` and then typed `bitterbot`
 * should not need to know the word "onboard". When the command has no
 * arguments at all, both stdin and stdout are terminals, CI is not set and
 * setup has not happened (`onboardingComplete`, the same definition the
 * gateway's `wizard.start` and `bitterbot onboard` use), the CLI prints one
 * line and runs `bitterbot onboard` by rewriting argv, so Commander runs the
 * real onboard command with its defaults. Everything else keeps printing help.
 */

import { parseBooleanValue } from "../utils/boolean.js";

export const BARE_COMMAND_SETUP_NOTICE = "Bitterbot isn't set up yet. Starting setup...";

export type BareCommandSetupContext = {
  /** argv as `runCli` sees it (after the entry strips --profile/--dev). */
  argv: string[];
  /** argv as typed, before the entry stripped --profile/--dev. */
  rawArgv?: string[];
  env: Record<string, string | undefined>;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
};

/** True when CI is set to anything but an explicit false ("0", "false", ...). */
function isCiEnv(env: Record<string, string | undefined>): boolean {
  const value = env.CI?.trim();
  if (!value) {
    return false;
  }
  return parseBooleanValue(value) !== false;
}

/**
 * The checks that need no disk access: no arguments or flags of any kind
 * (help, version, --profile and --dev included), an interactive terminal on
 * both ends, and no CI.
 */
export function isBareInteractiveInvocation(ctx: BareCommandSetupContext): boolean {
  if (ctx.argv.length > 2) {
    return false;
  }
  if (ctx.rawArgv && ctx.rawArgv.length > 2) {
    return false;
  }
  if (!ctx.stdinIsTty || !ctx.stdoutIsTty) {
    return false;
  }
  return !isCiEnv(ctx.env);
}

export async function shouldStartSetupForBareCommand(
  ctx: BareCommandSetupContext & { isSetUp: () => Promise<boolean> },
): Promise<boolean> {
  if (!isBareInteractiveInvocation(ctx)) {
    return false;
  }
  try {
    return !(await ctx.isSetUp());
  } catch {
    // Unreadable state: keep the old behaviour (help) rather than guess.
    return false;
  }
}

async function defaultIsSetUp(): Promise<boolean> {
  const { onboardingComplete } = await import("../wizard/onboarding.first-boot.js");
  return await onboardingComplete();
}

/**
 * Returns argv rewritten to `onboard` (after printing the notice) when bare
 * `bitterbot` should start setup, else argv unchanged.
 */
export async function resolveBareCommandArgv(
  argv: string[],
  deps: {
    rawArgv?: string[];
    env?: Record<string, string | undefined>;
    stdinIsTty?: boolean;
    stdoutIsTty?: boolean;
    isSetUp?: () => Promise<boolean>;
    log?: (line: string) => void;
  } = {},
): Promise<string[]> {
  const start = await shouldStartSetupForBareCommand({
    argv,
    rawArgv: deps.rawArgv,
    env: deps.env ?? process.env,
    stdinIsTty: deps.stdinIsTty ?? Boolean(process.stdin.isTTY),
    stdoutIsTty: deps.stdoutIsTty ?? Boolean(process.stdout.isTTY),
    isSetUp: deps.isSetUp ?? defaultIsSetUp,
  });
  if (!start) {
    return argv;
  }
  (deps.log ?? ((line: string) => console.log(line)))(BARE_COMMAND_SETUP_NOTICE);
  return [...argv, "onboard"];
}
