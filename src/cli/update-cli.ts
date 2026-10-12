import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";
import { updatePreflightCommand } from "./update-cli/preflight.js";
import {
  type UpdateCommandOptions,
  type UpdateStatusOptions,
  type UpdateWizardOptions,
} from "./update-cli/shared.js";
import { updateStatusCommand } from "./update-cli/status.js";
import { updateCommand } from "./update-cli/update-command.js";
import { updateWizardCommand } from "./update-cli/wizard.js";

export { updateCommand, updateStatusCommand, updateWizardCommand };
export type { UpdateCommandOptions, UpdateStatusOptions, UpdateWizardOptions };

/**
 * Commander hands `--json` / `--timeout` written AFTER a subcommand
 * (`update status --json`) to the `update` command itself, which defines
 * the same flags, so the subcommand's own value stays at its default. The
 * subcommands read the parent's value too.
 */
function parentOption(command: Command, name: string): unknown {
  return command.parent?.opts()[name];
}

function parentJson(command: Command): boolean {
  return parentOption(command, "json") === true;
}

export function registerUpdateCli(program: Command) {
  const update = program
    .command("update")
    .description("Update Bitterbot to the latest version")
    .option("--json", "Output result as JSON", false)
    .option("--no-restart", "Skip restarting the gateway service after a successful update")
    .option("--channel <stable|beta|dev>", "Persist update channel (git + npm; tarball: stable)")
    .option(
      "--tag <dist-tag|version>",
      "Override npm dist-tag or version for this update (tarball: a release version)",
    )
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1200)")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .option("--check", "Only report whether an update is available", false)
    .option("--rollback", "Release-tarball installs: switch back to the previous version", false)
    .option(
      "--reinstall",
      "Release-tarball installs: re-download and replace the current version",
      false,
    )
    .option(
      "--restore-data",
      "With --rollback: also restore memory databases from the pre-update snapshot (loses writes since the update)",
      false,
    )
    .addHelpText("after", () => {
      const examples = [
        ["bitterbot update", "Update a source checkout (git)"],
        ["bitterbot update --channel beta", "Switch to beta channel (git + npm)"],
        ["bitterbot update --channel dev", "Switch to dev channel (git + npm)"],
        ["bitterbot update --tag beta", "One-off update to a dist-tag or version"],
        ["bitterbot update --no-restart", "Update without restarting the service"],
        ["bitterbot update --json", "Output result as JSON"],
        ["bitterbot update --check", "Report whether an update is available"],
        ["bitterbot update --rollback", "Release-tarball installs: back to the previous version"],
        ["bitterbot update --yes", "Non-interactive (accept downgrade prompts)"],
        ["bitterbot update wizard", "Interactive update wizard"],
        ["bitterbot --update", "Shorthand for bitterbot update"],
      ] as const;
      const fmtExamples = examples
        .map(([cmd, desc]) => `  ${theme.command(cmd)} ${theme.muted(`# ${desc}`)}`)
        .join("\n");
      return `
${theme.heading("What this does:")}
  - Git checkouts: fetches, rebases, installs deps, builds, and runs doctor
  - npm installs: updates via detected package manager
  - Release-tarball installs (install.sh): verified download (pinned minisign key),
    snapshot of ~/.bitterbot data, new version checked, then switched in;
    rolled back automatically if it does not boot (--rollback to switch by hand)
  - Containers: pull a newer image (docker compose pull && docker compose up -d)

${theme.heading("Switch channels:")}
  - Use --channel stable|beta|dev to persist the update channel in config
  - Run bitterbot update status to see the active channel and source
  - Use --tag <dist-tag|version> for a one-off npm update without persisting

${theme.heading("Non-interactive:")}
  - Use --yes to accept downgrade prompts
  - Combine with --channel/--tag/--restart/--json/--timeout as needed

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Switch channels with --channel stable|beta|dev
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.bitterbot.ai/cli/update")}`;
    })
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
          check: Boolean(opts.check),
          rollback: Boolean(opts.rollback),
          reinstall: Boolean(opts.reinstall),
          restoreData: Boolean(opts.restoreData),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("wizard")
    .description("Interactive update wizard")
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1200)")
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.bitterbot.ai/cli/update")}\n`,
    )
    .action(async (opts) => {
      try {
        await updateWizardCommand({
          timeout: opts.timeout as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Hidden: the activation check a NEW release-tarball version runs with its
  // own code before the updater switches to it (PLAN-56 Phase 3b).
  update
    .command("preflight", { hidden: true })
    .description("Internal: check that this version can run on this machine's config and data")
    .option("--json", "Output result as JSON", false)
    .action(async (opts, command: Command) => {
      try {
        await updatePreflightCommand({ json: Boolean(opts.json) || parentJson(command) });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("status")
    .description("Show update channel and version status")
    .option("--json", "Output result as JSON", false)
    .option("--timeout <seconds>", "Timeout for update checks in seconds (default: 3)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["bitterbot update status", "Show channel + version status."],
          ["bitterbot update status --json", "JSON output."],
          ["bitterbot update status --timeout 10", "Custom timeout."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Shows current update channel (stable/beta/dev) and source",
        )}\n${theme.muted("- Includes git tag/branch/SHA for source checkouts")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.bitterbot.ai/cli/update")}`,
    )
    .action(async (opts, command: Command) => {
      try {
        await updateStatusCommand({
          json: Boolean(opts.json) || parentJson(command),
          timeout: (opts.timeout ?? parentOption(command, "timeout")) as string | undefined,
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
