/**
 * PLAN-39 r1 / PLAN-41 Phase 2: the gateway serves the Control UI itself, so
 * a missing build means the primary interface silently 404s. Shared by the
 * CLI doctor and the gateway's doctor.findings RPC.
 */
import type { BitterbotConfig } from "../config/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveControlUiRoot } from "../gateway/control-ui-assets.js";
import { renderSection, type CheckResult, error, info, ok } from "./doctor-check.js";

export async function runControlUiChecks(cfg: BitterbotConfig): Promise<void> {
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
            `Fix: ${formatCliCommand("pnpm ui:build")} (or set gateway.controlUi.root to the built directory).`,
        ),
      );
    }
  }
  renderSection("Control UI", results);
}
