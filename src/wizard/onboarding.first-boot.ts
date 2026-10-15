/**
 * True when a config file holds nothing but what a first gateway start
 * writes on its own: the generated `gateway.auth` token (container first
 * boot, PLAN-56 Phase 2), the `meta` stamp and the `commands` schema
 * default that writes before the drift-pass fix added. Onboarding treats that as "not set up yet"
 * instead of offering to keep/modify/reset an "existing config". Pass the
 * file's own content (snapshot.resolved), never the defaults-applied config.
 */
export function isFirstBootOnlyConfig(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return true;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "meta" && key !== "commands" && key !== "gateway") {
      return false;
    }
  }
  const gateway = record.gateway;
  if (gateway === undefined) {
    return true;
  }
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return false;
  }
  const gatewayKeys = Object.keys(gateway);
  if (!gatewayKeys.every((key) => key === "auth")) {
    return false;
  }
  const auth = (gateway as Record<string, unknown>).auth;
  if (auth === undefined) {
    return true;
  }
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    return false;
  }
  // Exactly what the first-boot token writes: a token, optionally with
  // mode "token". A password, trusted-proxy or any other auth setting was
  // chosen by a person.
  const authRecord = auth as Record<string, unknown>;
  const onlyTokenKeys = Object.keys(authRecord).every((key) => key === "mode" || key === "token");
  const tokenMode = authRecord.mode === undefined || authRecord.mode === "token";
  return onlyTokenKeys && tokenMode;
}

/**
 * True when a config snapshot shows a finished setup: a config file holding
 * more than a first gateway start writes, with no browser setup left half
 * done (a setup that wrote part of the config and then lost its session is
 * not finished; the next setup link may finish it). The one definition of
 * "set up" for `wizard.start`, `bitterbot onboard` and the bare `bitterbot`
 * command.
 */
export function isSetUpSnapshot(
  snapshot: { exists: boolean; resolved: unknown },
  opts: { setupInProgress: boolean },
): boolean {
  return snapshot.exists && !isFirstBootOnlyConfig(snapshot.resolved) && !opts.setupInProgress;
}

/** Reads the config file and the setup marker: `isSetUpSnapshot` for this machine. */
export async function onboardingComplete(): Promise<boolean> {
  const { setupInProgress } = await import("../gateway/setup-token.js");
  if (setupInProgress()) {
    return false;
  }
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  return isSetUpSnapshot(snapshot, { setupInProgress: false });
}
