/**
 * PLAN-62: the HTTP side of the phone app.
 *
 *   GET  /m                    -> 302 /m/ (the service worker's scope is /m/)
 *   GET  /m/...                -> the built phone app, served by the Control UI
 *                                 static handler (public: it is a static shell,
 *                                 every byte of data sits behind the WebSocket)
 *   POST /m/api/pair/claim     -> a phone claims a setup code with its device key
 *   POST /m/api/pair/status    -> the phone polls for the owner's decision
 *
 * The two POSTs take JSON only (a cross-site HTML form cannot send it without a
 * CORS preflight, which this endpoint never answers), refuse a foreign Origin,
 * and are rate limited per client IP. The setup code itself is a 128-bit
 * one-time secret, so the limit is about noise, not brute force.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveRequestClientIp } from "../auth.js";
import { resolveControlUiRoot } from "../control-ui-assets.js";
import { readJsonBody } from "../hooks.js";
import { claimSetupCode, readClaimStatus, type ClaimInput } from "./pairing.js";

const log = createSubsystemLogger("mobile-pair");

const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const LIMITS = { claim: 20, status: 240 } as const;

const hits = new Map<string, number[]>();

function rateLimited(key: string, limit: number, now = Date.now()): boolean {
  const times = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= limit) {
    hits.set(key, times);
    return true;
  }
  times.push(now);
  hits.set(key, times);
  if (hits.size > 2000) {
    const oldest = hits.keys().next().value;
    if (oldest !== undefined) {
      hits.delete(oldest);
    }
  }
  return false;
}

/** Test hook. */
export function resetMobileHttpRateLimitsForTests() {
  hits.clear();
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

/** A browser always sends Origin on POST; when it does, it must be this gateway. */
export function isSameOriginPost(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (origin === "null") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const forwardedHost = req.headers["x-forwarded-host"];
    const host = (typeof forwardedHost === "string" && forwardedHost) || req.headers.host || "";
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export type MobileHttpOptions = {
  basePath: string;
  enabled: boolean;
  trustedProxies: string[];
  configuredRoot?: string;
};

/** Returns true when the request was handled. */
export async function handleMobileHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MobileHttpOptions,
): Promise<boolean> {
  const rawUrl = req.url ?? "/";
  let pathname: string;
  let search: string;
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    return false;
  }
  const base = opts.basePath;
  const mobileRoot = `${base}/m`;
  if (pathname !== mobileRoot && !pathname.startsWith(`${mobileRoot}/`)) {
    return false;
  }
  if (!opts.enabled) {
    sendJson(res, 404, { error: "the phone app is turned off on this gateway" });
    return true;
  }
  const method = req.method ?? "GET";

  if (pathname === mobileRoot && (method === "GET" || method === "HEAD")) {
    res.statusCode = 302;
    res.setHeader("Location", `${mobileRoot}/${search}`);
    res.setHeader("Cache-Control", "no-store");
    res.end();
    return true;
  }

  if (pathname === `${mobileRoot}/api/pair/claim` || pathname === `${mobileRoot}/api/pair/status`) {
    if (method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end();
      return true;
    }
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, { error: "application/json required" });
      return true;
    }
    if (!isSameOriginPost(req)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    const ip = resolveRequestClientIp(req, opts.trustedProxies) ?? "unknown";
    const kind = pathname.endsWith("/claim") ? "claim" : "status";
    if (rateLimited(`${kind}:${ip}`, LIMITS[kind])) {
      res.setHeader("Retry-After", "30");
      sendJson(res, 429, { error: "too many requests, try again shortly" });
      return true;
    }
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 400, { error: body.error });
      return true;
    }
    const value = (body.value ?? {}) as Record<string, unknown>;
    if (kind === "claim") {
      const result = await claimSetupCode({
        code: typeof value.code === "string" ? value.code : "",
        device: value.device as ClaimInput["device"],
        displayName: typeof value.displayName === "string" ? value.displayName : undefined,
        platform: typeof value.platform === "string" ? value.platform : undefined,
        remoteIp: ip,
      });
      if (!result.ok) {
        sendJson(res, result.status, { error: result.error });
        return true;
      }
      if (result.created) {
        log.info(
          `phone claimed setup=${result.request.setupId ?? "?"} request=${result.request.requestId}`,
        );
        onClaimed?.(result.request);
      }
      sendJson(res, 200, {
        claimId: result.claimId,
        confirmCode: result.confirmCode,
        requestId: result.request.requestId,
      });
      return true;
    }
    const status = await readClaimStatus({
      claimId: typeof value.claimId === "string" ? value.claimId : "",
      deviceId: typeof value.deviceId === "string" ? value.deviceId : "",
    });
    sendJson(res, 200, status);
    return true;
  }

  if (method !== "GET" && method !== "HEAD") {
    return false;
  }
  // The app itself is served by the Control UI static handler further down
  // the chain. When no UI is staged, say so instead of a bare 404.
  const root = await resolveControlUiRoot({ configuredRoot: opts.configuredRoot });
  if (!root && (pathname === `${mobileRoot}/` || pathname === `${mobileRoot}/index.html`)) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      "The Bitterbot phone app ships with the Control UI build, and this install has none.\n" +
        "From a source checkout run `pnpm ui:build`, then reload.",
    );
    return true;
  }
  return false;
}

type ClaimListener = (
  request: import("../../infra/device-pairing.js").DevicePairingPendingRequest,
) => void;
let onClaimed: ClaimListener | null = null;

/** The gateway broadcasts `device.pair.requested` for a new phone claim. */
export function setMobileClaimListener(listener: ClaimListener | null) {
  onClaimed = listener;
}

/** True for the static paths a phone must load without a gateway credential. */
export function isPublicMobileAssetPath(relative: string): boolean {
  return (
    relative === "/m/" ||
    relative.startsWith("/m/") ||
    relative.startsWith("/assets/") ||
    relative.startsWith("/fonts/") ||
    relative === "/bitterbot-favicon.svg" ||
    relative === "/Bitterbot_logo.svg" ||
    relative === "/bitterbot_avatar.png"
  );
}
