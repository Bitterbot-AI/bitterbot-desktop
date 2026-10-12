/**
 * Connect-time decision for a setup-token connection (PLAN-56 Phase 4).
 * See src/gateway/setup-token.ts for the token's rules.
 */

import { looksLikeContainer, readDeclaredInstallKind } from "../../../infra/install-kind.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import {
  SETUP_EVENTS,
  SETUP_METHODS,
  SETUP_SCOPE,
  setupTokenRequestAllowed,
  verifySetupToken,
} from "../../setup-token.js";

export { SETUP_SCOPE };

export type SetupConnectDecision = { ok: true } | { ok: false; reason: string; message: string };

export async function decideSetupConnect(params: {
  token: string;
  hostHeader: string | undefined;
  remoteIsLoopback: boolean;
  hasProxyHeaders: boolean;
  role: string | null;
  /** Test seams. */
  inContainer?: boolean;
  stateDir?: string;
  now?: number;
}): Promise<SetupConnectDecision> {
  if (params.role !== "operator") {
    return { ok: false, reason: "role", message: "setup token: operator role only" };
  }
  const inContainer =
    params.inContainer ?? (readDeclaredInstallKind() === "container" || looksLikeContainer());
  if (
    !setupTokenRequestAllowed({
      hostHeader: params.hostHeader,
      remoteIsLoopback: params.remoteIsLoopback,
      hasProxyHeaders: params.hasProxyHeaders,
      inContainer,
    })
  ) {
    return {
      ok: false,
      reason: "not-loopback",
      message: "setup links work only at http://127.0.0.1 on the gateway's own machine",
    };
  }
  const check = verifySetupToken(params.token, { stateDir: params.stateDir, now: params.now });
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason,
      message:
        check.reason === "expired"
          ? "setup link expired; run `bitterbot onboard` for a new one"
          : "setup link not valid; run `bitterbot onboard` for a new one",
    };
  }
  return { ok: true };
}

/** The hello a setup connection gets: no snapshot, no presence, wizard methods only. */
export function buildSetupHello(params: { connId: string; protocol: number }) {
  return {
    type: "hello-ok" as const,
    protocol: params.protocol,
    server: {
      version: process.env.BITTERBOT_VERSION ?? process.env.npm_package_version ?? "dev",
      connId: params.connId,
    },
    features: { methods: [...SETUP_METHODS], events: [...SETUP_EVENTS] },
    auth: { role: "operator", scopes: [SETUP_SCOPE] },
    policy: {
      maxPayload: MAX_PAYLOAD_BYTES,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
      tickIntervalMs: TICK_INTERVAL_MS,
    },
  };
}
