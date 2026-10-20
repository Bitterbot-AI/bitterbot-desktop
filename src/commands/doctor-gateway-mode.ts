import { formatCliCommand } from "../cli/command-format.js";
import type { InstallKind } from "../infra/install-kind.js";
import { type CheckResult, info, warn } from "./doctor-check.js";

/**
 * gateway.mode unset. A missing config file is not an error (PLAN-56 Phase 2:
 * defaults apply without one), and the container image always starts the
 * gateway with `--allow-unconfigured`, so there it is informational.
 */
export function gatewayModeUnsetFinding(params: {
  installKind: InstallKind;
  configFileExists: boolean;
}): CheckResult {
  const setDirectly = `Set it: ${formatCliCommand("bitterbot config set gateway.mode local")}`;
  if (params.installKind === "container") {
    return info(
      [
        "gateway.mode is unset. Expected in the container: the image starts the gateway",
        "with --allow-unconfigured, so nothing is blocked.",
        setDirectly,
      ].join("\n"),
    );
  }
  const lines = [
    "gateway.mode is unset; `bitterbot gateway` will refuse to start without --allow-unconfigured.",
    `Fix: run ${formatCliCommand("bitterbot onboard")} (or ${formatCliCommand("bitterbot configure")}) and pick a local gateway.`,
    setDirectly,
  ];
  if (!params.configFileExists) {
    lines.push(
      "No config file yet. Every other default applies without one, but the gateway still needs gateway.mode (onboarding sets it).",
    );
  }
  return warn(lines.join("\n"));
}
