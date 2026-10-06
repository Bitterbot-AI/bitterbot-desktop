/**
 * First-device pairing for a fresh remote gateway (PLAN-53 F1).
 *
 * A gateway deployed to a cloud host has no local browser, so the first
 * Control UI connection used to stop at "pairing required" with only a CLI
 * inside the container to approve it. When the deployment opts in, the first
 * Control UI device that proves the gateway token or password is paired on
 * the spot, but only while no device is paired, only as an operator with the
 * Control UI's own scopes, and only once: a marker file closes the window for
 * good, even if every device is later removed.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/** What the Control UI asks for (desktop/renderer/src/lib/gateway-client.ts). */
export const CONTROL_UI_SCOPES: ReadonlySet<string> = new Set([
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
]);

/** On only when the config says so or the deploy template sets the env var. */
export function bootstrapPairingEnabled(configured: boolean | undefined): boolean {
  if (configured !== undefined) {
    return configured;
  }
  return process.env.BITTERBOT_BOOTSTRAP_PAIRING === "1";
}

function markerPath(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "devices", "bootstrap-pairing-used");
}

export function bootstrapPairingUsed(stateDir?: string): boolean {
  return fs.existsSync(markerPath(stateDir));
}

export function markBootstrapPairingUsed(stateDir?: string): void {
  const file = markerPath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function bootstrapPairingAllowed(params: {
  isControlUi: boolean;
  /** The connection proved the shared gateway token or password. */
  sharedAuthOk: boolean;
  enabled: boolean;
  /** Why pairing is needed: only a brand-new device, never a scope or role upgrade. */
  reason: string;
  pairedCount: number;
  role: string | null;
  scopes: string[];
  alreadyUsed: boolean;
}): boolean {
  return (
    params.enabled &&
    !params.alreadyUsed &&
    params.isControlUi &&
    params.sharedAuthOk &&
    params.reason === "not-paired" &&
    params.pairedCount === 0 &&
    params.role === "operator" &&
    params.scopes.every((s) => CONTROL_UI_SCOPES.has(s))
  );
}
