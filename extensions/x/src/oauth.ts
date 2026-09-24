/**
 * OAuth 2.0 Authorization Code + PKCE login for X.
 *
 * Flow: build authorize URL -> open browser -> X redirects to a one-shot
 * loopback HTTP server on 127.0.0.1:<port>/callback -> exchange code.
 * The redirect URI must be registered on the X app exactly as printed.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { XAccountConfig, XTokenRecord } from "./types.js";
import { X_TOKEN_URL, buildClientAuthHeaders, tokenResponseToRecord } from "./token-store.js";

export const X_AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"] as const;
export const DEFAULT_CALLBACK_PORT = 19010;
export const CALLBACK_PATH = "/callback";

export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", X_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeCode(params: {
  account: XAccountConfig;
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<XTokenRecord> {
  const fetcher = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.account.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier,
  });
  const res = await fetcher(X_TOKEN_URL, {
    method: "POST",
    headers: buildClientAuthHeaders(params.account),
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `X code exchange failed (${res.status}): ${String(payload.error_description ?? payload.error ?? res.statusText)}`,
    );
  }
  return tokenResponseToRecord(payload, null, params.now);
}

/** Wait for exactly one callback hit carrying our state; resolves with the code. */
export function waitForCallback(params: {
  port: number;
  state: string;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${params.port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (error) {
        res.statusCode = 400;
        res.end(`<h2>X authorization failed: ${escapeHtml(error)}</h2>`);
        finish(new Error(`X authorization denied: ${error}`));
        return;
      }
      if (state !== params.state || !code) {
        res.statusCode = 400;
        res.end("<h2>State mismatch. Close this tab and retry the login.</h2>");
        finish(new Error("OAuth state mismatch"));
        return;
      }
      res.statusCode = 200;
      res.end("<h2>Bitterbot is authorized on X. You can close this tab.</h2>");
      finish(null, code);
    });
    const timer = setTimeout(
      () => finish(new Error("Timed out waiting for the X authorization callback")),
      params.timeoutMs ?? 5 * 60 * 1000,
    );
    let done = false;
    const finish = (err: Error | null, code?: string) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      // Drop keep-alive sockets too, so a retry on the same port is not
      // served by this (finished) server's lingering connection.
      server.closeAllConnections?.();
      server.close();
      if (err) {
        reject(err);
      } else {
        resolve(code ?? "");
      }
    };
    server.on("error", (err) => finish(err));
    server.listen(params.port, "127.0.0.1");
  });
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export async function loginWithBrowser(params: {
  account: XAccountConfig;
  port?: number;
  openUrl: (url: string) => Promise<unknown>;
  log: (msg: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<XTokenRecord> {
  const port = params.port ?? params.account.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = buildRedirectUri(port);
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("base64url");
  const url = buildAuthorizeUrl({
    clientId: params.account.clientId,
    redirectUri,
    state,
    challenge,
  });

  const callback = waitForCallback({ port, state });
  params.log(`Redirect URI (must be registered on the X app): ${redirectUri}`);
  params.log(`Opening: ${url}`);
  await params.openUrl(url).catch(() => undefined);
  const code = await callback;
  return exchangeCode({
    account: params.account,
    code,
    verifier,
    redirectUri,
    fetchImpl: params.fetchImpl,
  });
}
