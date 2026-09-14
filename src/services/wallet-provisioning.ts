/**
 * Wallet provisioning mode resolver (PLAN-49 Phase 0.5).
 *
 * Decides how the wallet is provisioned for a given config, so the gateway, the
 * Control UI, and the wallet service all agree without re-deriving the rules:
 *
 *   - "embedded": a per-user CDP Embedded Wallet the user creates by signing in
 *     (email OTP) in the Control UI; the gateway signs via a time-bound delegation.
 *     Non-custodial. Selected ONLY when explicitly opted in AND a `projectId` is
 *     present (the frontend SDK cannot init without it) — otherwise we fall back
 *     rather than ship a half-configured money surface.
 *   - "selfHostServer" (default): today's single CDP Server Wallet keyed by the
 *     operator's CDP secrets. Byte-identical to pre-Phase-0.5 behavior (J4).
 *
 * Pure: no I/O, no SDK calls. The live embedded flow (sign-in + delegated signing)
 * plugs in behind this decision.
 */

export type WalletProvisioningMode = "embedded" | "selfHostServer";

export interface WalletProvisioningView {
  mode: WalletProvisioningMode;
  /** Public CDP project id for the embedded SDK (only when mode === "embedded"). */
  embeddedProjectId?: string;
  /** Why we are NOT in embedded mode, when the operator asked for it but it can't run. */
  reason?: string;
}

/** The slice of wallet config this resolver reads. */
export interface WalletProvisioningConfig {
  provisioning?: WalletProvisioningMode;
  embedded?: { projectId?: string };
}

/**
 * Resolve the effective provisioning mode. Embedded requires an explicit
 * `provisioning: "embedded"` AND a non-empty `embedded.projectId`; anything else
 * resolves to the self-host server wallet (the safe, existing path).
 */
export function resolveWalletProvisioning(cfg?: WalletProvisioningConfig): WalletProvisioningView {
  if (cfg?.provisioning !== "embedded") {
    return { mode: "selfHostServer" };
  }
  const projectId = cfg.embedded?.projectId?.trim();
  if (!projectId) {
    return {
      mode: "selfHostServer",
      reason: "embedded requested but embedded.projectId is not set (falling back to self-host)",
    };
  }
  return { mode: "embedded", embeddedProjectId: projectId };
}
