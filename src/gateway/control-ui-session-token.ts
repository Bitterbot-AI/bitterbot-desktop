import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * PLAN-39 Phase 3: same-origin token handoff for the gateway-served Control UI.
 *
 * Replaces baking the gateway token into the JS bundle at build time
 * (`VITE_GATEWAY_TOKEN`, PLAN-37 item 13). The renderer asks the gateway it was
 * served from for the token, over the connection it already trusts.
 *
 * This is new attack surface and is gated twice:
 *
 * 1. `isLocalDirectRequest` (supplied by the caller), the same trust the existing
 *    token-injecting HTML pages encode: the connection arrived on a loopback
 *    socket and carried no proxy headers.
 *
 * 2. A `Host` header allowlist, which is NOT redundant with (1). A DNS rebinding
 *    attack satisfies the socket-level check completely: the victim's browser is
 *    told `evil.example` resolves to 127.0.0.1, then connects to the gateway from
 *    the victim's own machine. As far as the socket is concerned that is an
 *    ordinary loopback request. What distinguishes it is the `Host` header, which
 *    still says `evil.example`. Rejecting unknown hosts is the control that stops
 *    a web page the user merely visited from reading their gateway token.
 */

/** Hostnames that are always acceptable for a loopback-served UI. */
const DEFAULT_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Split a Host header into hostname and port, handling bracketed IPv6. */
export function parseHostHeader(raw: string | undefined): { host: string; port?: string } | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) {
      return null;
    }
    const host = value.slice(0, end + 1);
    const rest = value.slice(end + 1);
    if (rest && !rest.startsWith(":")) {
      return null;
    }
    return { host, port: rest ? rest.slice(1) : undefined };
  }
  const parts = value.split(":");
  if (parts.length > 2) {
    return null;
  }
  const host = parts[0];
  if (!host) {
    return null;
  }
  return { host, port: parts[1] };
}

/**
 * True when the request's Host header names this gateway.
 *
 * Rejects a missing or malformed Host outright: a browser always sends one, so
 * its absence means the caller is not the case this endpoint exists to serve.
 */
export function isAllowedHost(params: {
  hostHeader: string | undefined;
  allowedHosts?: string[];
}): boolean {
  const parsed = parseHostHeader(params.hostHeader);
  if (!parsed) {
    return false;
  }
  const host = parsed.host.toLowerCase();
  if (DEFAULT_ALLOWED_HOSTS.has(host)) {
    return true;
  }
  return (params.allowedHosts ?? []).some((allowed) => {
    const candidate = parseHostHeader(allowed);
    return candidate ? candidate.host.toLowerCase() === host : false;
  });
}

export type SessionTokenOptions = {
  /** The gateway auth token to hand over, if one is configured. */
  token?: string;
  /** `gateway.controlUi.allowedHosts`, for Tailscale Serve names and the like. */
  allowedHosts?: string[];
  /** Loopback + no-proxy-headers check. */
  isLocalDirect: (req: IncomingMessage) => boolean;
};

/** The path this endpoint answers on, relative to the Control UI base path. */
export const SESSION_TOKEN_PATH = "/auth/session-token";

/**
 * Returns true when the request was handled.
 *
 * Always answers 403 rather than 404 for a rejected caller: whether a UI is
 * mounted is not a secret, but the reason for refusal should not be a probing
 * oracle either, so every rejection looks alike.
 */
export function handleSessionTokenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SessionTokenOptions,
): boolean {
  if ((req.method ?? "GET") !== "GET") {
    return false;
  }

  const deny = () => {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  };

  if (!opts.isLocalDirect(req)) {
    return deny();
  }
  if (!isAllowedHost({ hostHeader: req.headers.host, allowedHosts: opts.allowedHosts })) {
    return deny();
  }
  if (!opts.token) {
    // No auth configured: there is nothing to hand over. Say so distinctly so the
    // renderer can skip FirstRun instead of prompting for a token that does not exist.
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ token: null }));
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // Never let a token sit in a shared or disk cache.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.end(JSON.stringify({ token: opts.token }));
  return true;
}
