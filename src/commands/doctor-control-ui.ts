/**
 * PLAN-39 r1 / PLAN-41 Phase 2: the gateway serves the Control UI itself, so
 * a missing build means the primary interface silently 404s. Shared by the
 * CLI doctor and the gateway's doctor.findings RPC.
 */

import { formatCliCommand } from "../cli/command-format.js";
import type { BitterbotConfig } from "../config/config.js";
import { resolveControlUiRoot } from "../gateway/control-ui-assets.js";
import {
  CONTAINER_UPDATE_COMMAND,
  type InstallKind,
  TARBALL_UPDATE_COMMAND,
} from "../infra/install-kind.js";
import { renderSection, type CheckResult, error, info, ok } from "./doctor-check.js";

/** How to get a built Control UI back, per install kind. */
export function controlUiMissingFix(kind: InstallKind | undefined): string {
  switch (kind) {
    case "container":
      return `the image should carry it; pull a current image on the Docker host: ${CONTAINER_UPDATE_COMMAND}`;
    case "tarball":
      return `the release tarball should carry it; re-run the installer: ${TARBALL_UPDATE_COMMAND}`;
    case "package":
      return "the package should carry it (dist/control-ui); reinstall the package";
    default:
      return `${formatCliCommand("pnpm ui:build")} (or set gateway.controlUi.root to the built directory)`;
  }
}

export async function runControlUiChecks(
  cfg: BitterbotConfig,
  installKind?: InstallKind,
): Promise<void> {
  const results: CheckResult[] = [];
  if (cfg.gateway?.controlUi?.enabled === false) {
    results.push(info("Control UI serving disabled (gateway.controlUi.enabled=false)."));
  } else {
    const root = await resolveControlUiRoot({
      configuredRoot: cfg.gateway?.controlUi?.root,
      useCache: false,
    });
    if (root) {
      results.push(ok(`Control UI staged at ${root}`));
    } else {
      results.push(
        error(
          `No built Control UI found — http://127.0.0.1:19001/ will 404. ` +
            `Fix: ${controlUiMissingFix(installKind)}.`,
        ),
      );
    }
  }
  renderSection("Control UI", results);
}
