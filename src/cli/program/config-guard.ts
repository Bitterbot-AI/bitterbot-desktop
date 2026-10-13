import {
  loadAndMaybeMigrateDoctorConfig,
  type DoctorConfigOutput,
} from "../../commands/doctor-config-flow.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { installerOutputMode } from "../../infra/installer-env.js";
import type { RuntimeEnv } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { shouldMigrateStateFromPath } from "../argv.js";
import { formatCliCommand } from "../command-format.js";

const ALLOWED_INVALID_COMMANDS = new Set(["doctor", "logs", "health", "help", "status"]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
  "status",
  "probe",
  "health",
  "discover",
  "call",
  "install",
  "uninstall",
  "start",
  "stop",
  "restart",
]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise: Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> | null =
  null;

function formatConfigIssues(issues: Array<{ path: string; message: string }>): string[] {
  return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}

async function getConfigSnapshot() {
  // Tests often mutate config fixtures; caching can make those flaky.
  if (process.env.VITEST === "true") {
    return readConfigFileSnapshot();
  }
  configSnapshotPromise ??= readConfigFileSnapshot();
  return configSnapshotPromise;
}

/**
 * How loud the config check before a command is. install.sh runs its first
 * command with BITTERBOT_INSTALLER=1 (one summary line) and the later ones
 * with BITTERBOT_INSTALLER=quiet (nothing), so an install shows config
 * advice at most once. Errors that stop a command always print.
 */
export function configGuardOutput(env: NodeJS.ProcessEnv): DoctorConfigOutput {
  return installerOutputMode(env) ?? "guard";
}

export async function ensureConfigReady(params: {
  runtime: RuntimeEnv;
  commandPath?: string[];
}): Promise<void> {
  const commandPath = params.commandPath ?? [];
  if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
    didRunDoctorConfigFlow = true;
    await loadAndMaybeMigrateDoctorConfig({
      options: { nonInteractive: true },
      confirm: async () => false,
      output: configGuardOutput(process.env),
      log: (line) => params.runtime.log(line),
    });
  }

  const snapshot = await getConfigSnapshot();
  const commandName = commandPath[0];
  const subcommandName = commandPath[1];
  const allowInvalid = commandName
    ? ALLOWED_INVALID_COMMANDS.has(commandName) ||
      (commandName === "gateway" &&
        subcommandName &&
        ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName))
    : false;
  const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
  const legacyIssues =
    snapshot.legacyIssues.length > 0
      ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`)
      : [];

  const invalid = snapshot.exists && !snapshot.valid;
  if (!invalid) {
    return;
  }

  const rich = isRich();
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const error = (value: string) => colorize(rich, theme.error, value);
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const commandText = (value: string) => colorize(rich, theme.command, value);

  params.runtime.error(heading("Config invalid"));
  params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
  if (issues.length > 0) {
    params.runtime.error(muted("Problem:"));
    params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  if (legacyIssues.length > 0) {
    params.runtime.error(muted("Legacy config keys detected:"));
    params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
  }
  params.runtime.error("");
  params.runtime.error(
    `${muted("Run:")} ${commandText(formatCliCommand("bitterbot doctor --fix"))}`,
  );
  if (!allowInvalid) {
    params.runtime.exit(1);
  }
}
