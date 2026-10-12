import type { BitterbotConfig } from "../config/config.js";

export function resolveGatewayProbeAuth(params: {
  cfg: BitterbotConfig;
  mode: "local" | "remote";
  env?: NodeJS.ProcessEnv;
}): { token?: string; password?: string } {
  const env = params.env ?? process.env;
  const authToken = params.cfg.gateway?.auth?.token;
  const authPassword = params.cfg.gateway?.auth?.password;
  const remote = params.cfg.gateway?.remote;

  const token =
    params.mode === "remote"
      ? typeof remote?.token === "string" && remote.token.trim()
        ? remote.token.trim()
        : undefined
      : // Local: config first, then env, like the server (resolveGatewayAuth).
        (typeof authToken === "string" && authToken.trim() ? authToken.trim() : undefined) ||
        env.BITTERBOT_GATEWAY_TOKEN?.trim() ||
        undefined;

  const password =
    params.mode === "remote"
      ? env.BITTERBOT_GATEWAY_PASSWORD?.trim() ||
        (typeof remote?.password === "string" && remote.password.trim()
          ? remote.password.trim()
          : undefined)
      : (typeof authPassword === "string" && authPassword.trim()
          ? authPassword.trim()
          : undefined) ||
        env.BITTERBOT_GATEWAY_PASSWORD?.trim() ||
        undefined;

  return { token, password };
}
