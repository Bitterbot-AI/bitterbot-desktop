/**
 * First-boot gateway token (PLAN-56 Phase 2, zero-edit compose).
 *
 * `docker compose up -d` with nothing set used to stop at "Refusing to bind
 * gateway to lan without auth". When the gateway is started for a fresh
 * install (`--allow-unconfigured`), would bind beyond loopback, and has NO
 * auth of any kind (no token, password, or trusted proxy, from config, env or
 * flags), it now generates a token and persists it the same way `bitterbot
 * doctor` and the onboarding wizard do: `gateway.auth.mode = "token"` and
 * `gateway.auth.token` in the config file. There is no second token store.
 *
 * In a container the token is printed ONCE, at generation, straight to
 * stdout: it lands in `docker compose logs` (readable only by whoever
 * controls the Docker host, who can read the config file anyway) but bypasses
 * the console capture that mirrors console output into the gateway's file log
 * (which the Control UI can tail). Outside a container only the retrieval
 * command is printed. Later it is shown on demand with
 * `bitterbot config get gateway.auth.token`.
 */

import crypto from "node:crypto";
import {
  type BitterbotConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { bootstrapPairingEnabled } from "../../gateway/bootstrap-pairing.js";
import { looksLikeContainer, readDeclaredInstallKind } from "../../infra/install-kind.js";

/** Same shape as the wizard's and doctor's `randomToken()` (48 hex chars). */
function randomToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export type FirstBootTokenDecision = {
  allowUnconfigured: boolean;
  bind: string;
  /** Resolved auth mode before generation ("none" means nothing configured). */
  authMode: string;
};

/** Generate only for a fresh, non-loopback start with no auth configured at all. */
export function shouldGenerateFirstBootToken(params: FirstBootTokenDecision): boolean {
  return params.allowUnconfigured && params.bind !== "loopback" && params.authMode === "none";
}

/** The command that shows the token again, phrased for where we run. */
export function formatTokenRetrievalCommand(inContainer: boolean): string {
  return inContainer
    ? "docker compose exec -u node bitterbot-gateway node bitterbot.mjs config get gateway.auth.token"
    : "bitterbot config get gateway.auth.token";
}

export function formatFirstBootTokenBanner(params: {
  token: string;
  configPath: string;
  port: number;
  inContainer: boolean;
  /** Bootstrap pairing (BITTERBOT_BOOTSTRAP_PAIRING=1 or the config switch) is on. */
  bootstrapPairing?: boolean;
}): string {
  const rule = "=".repeat(72);
  const where = params.inContainer
    ? `http://127.0.0.1:${params.port}/ (or the host port you mapped)`
    : `http://127.0.0.1:${params.port}/`;
  // Only a container's stdout is the operator's own console (`docker compose
  // logs`, readable by whoever controls the Docker host). A service manager's
  // stdout usually lands in a log file with looser permissions than the
  // 0600 config, so outside a container the token itself is not printed.
  const tokenLine = params.inContainer
    ? `  Token:  ${params.token}`
    : `  Token:  run \`${formatTokenRetrievalCommand(false)}\``;
  return [
    rule,
    "Bitterbot generated a gateway token on first boot and saved it to",
    `${params.configPath} (gateway.auth.token).`,
    "",
    `  Open:   ${where}`,
    tokenLine,
    "",
    ...(params.bootstrapPairing
      ? [
          "Paste the token when the Control UI asks for it; the first browser that",
          "signs in with it is paired. Show the token again later with:",
        ]
      : [
          "Paste the token when the Control UI asks for it, then approve the browser",
          "with `devices approve`. Show the token again later with:",
        ]),
    `  ${formatTokenRetrievalCommand(params.inContainer)}`,
    "Anyone with this token can control the agent: keep it private.",
    rule,
    "",
  ].join("\n");
}

/**
 * Generate, persist and announce a token. Throws (without writing) when the
 * existing config file is invalid: never clobber a file the user must fix.
 */
export async function generateFirstBootToken(params: {
  port: number;
  write?: (text: string) => void;
  /** Test seams. */
  readSnapshot?: typeof readConfigFileSnapshot;
  writeConfig?: typeof writeConfigFile;
  makeToken?: () => string;
  inContainer?: boolean;
  bootstrapPairing?: boolean;
}): Promise<string> {
  const readSnapshot = params.readSnapshot ?? readConfigFileSnapshot;
  const writeConfig = params.writeConfig ?? writeConfigFile;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(
      `Cannot generate a gateway token: the config at ${snapshot.path} is invalid. Fix it, or set BITTERBOT_GATEWAY_TOKEN.`,
    );
  }
  const token = (params.makeToken ?? randomToken)();
  // A missing file's snapshot.config carries the load-time defaults; writing
  // those would freeze today's defaults (bootstrap peers, etc.) into the
  // file. Start from {} so the new file holds only the token.
  const base: BitterbotConfig = snapshot.exists ? snapshot.config : {};
  const next: BitterbotConfig = {
    ...base,
    gateway: {
      ...base.gateway,
      auth: {
        ...base.gateway?.auth,
        mode: "token",
        token,
      },
    },
  };
  await writeConfig(next);
  const inContainer =
    params.inContainer ?? (readDeclaredInstallKind() === "container" || looksLikeContainer());
  const write = params.write ?? ((text: string) => void process.stdout.write(text));
  write(
    formatFirstBootTokenBanner({
      token,
      configPath: snapshot.path,
      port: params.port,
      inContainer,
      bootstrapPairing:
        params.bootstrapPairing ??
        bootstrapPairingEnabled(base.gateway?.controlUi?.bootstrapPairing),
    }),
  );
  return token;
}

/**
 * The server uses gateway.auth.token from the config over
 * BITTERBOT_GATEWAY_TOKEN. When both are set and differ (typically a token
 * generated on first boot, then an env var added later), say so at startup
 * without printing either value; null when there is nothing to warn about.
 */
export function describeTokenSourceConflict(
  configToken: string | undefined,
  envToken: string | undefined,
): string | null {
  const fromConfig = configToken?.trim();
  const fromEnv = envToken?.trim();
  if (!fromConfig || !fromEnv || fromConfig === fromEnv) {
    return null;
  }
  return (
    "BITTERBOT_GATEWAY_TOKEN differs from gateway.auth.token in the config file; " +
    "the config token is the one in use. Remove one, or change the config token with " +
    "`config set gateway.auth.token <new>` and restart."
  );
}
