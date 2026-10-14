/**
 * Variables install.sh sets for its own short-lived commands (quiet config
 * advice, no banner, test-mode overrides). A long-lived process started from
 * one of those commands (a setup gateway, a gateway started by `gateway
 * switch`) must not inherit them: they would silence its config warnings and
 * reach everything it runs.
 */

export const INSTALLER_ONLY_ENV = [
  "BITTERBOT_INSTALLER",
  "BITTERBOT_HIDE_BANNER",
  "BITTERBOT_INSTALL_TEST_MODE",
  "BITTERBOT_INSTALL_BASE_URL",
  "BITTERBOT_INSTALL_TEST_PUBKEY",
  "BITTERBOT_INSTALL_TEST_VERIFIER",
] as const;

/** `env` without the installer's per-command variables. */
export function withoutInstallerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of INSTALLER_ONLY_ENV) {
    delete next[key];
  }
  return next;
}

/**
 * The installer's output mode: BITTERBOT_INSTALLER=1 (one summary line) or
 * =quiet (nothing). Any other value means a normal run.
 */
export function installerOutputMode(env: NodeJS.ProcessEnv): "summary" | "silent" | null {
  const raw = env.BITTERBOT_INSTALLER?.trim();
  if (raw === "1") {
    return "summary";
  }
  if (raw === "quiet") {
    return "silent";
  }
  return null;
}
