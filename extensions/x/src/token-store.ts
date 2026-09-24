/**
 * OAuth 2.0 user token persistence + refresh for X.
 *
 * Tokens never live in bitterbot.json: they are written to
 * <stateDir>/x/<accountId>.token.json with mode 0600. X rotates refresh
 * tokens on every refresh (the old one is invalidated), so the new bundle is
 * persisted BEFORE the access token is handed back to the caller.
 *
 * Env fallback (default account only): BITTERBOT_X_ACCESS_TOKEN. No refresh
 * is possible in that mode; it exists for smoke tests.
 */

import { withFileLock } from "bitterbot/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";
import type { XAccountConfig, XTokenRecord } from "./types.js";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { resolveTokenFilePath } from "./paths.js";

export const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type TokenSource = "file" | "env" | "none";

export async function readTokenRecord(tokenFile: string): Promise<XTokenRecord | null> {
  try {
    const raw = await fs.readFile(tokenFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<XTokenRecord>;
    if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      username: typeof parsed.username === "string" ? parsed.username : undefined,
      obtainedAt: typeof parsed.obtainedAt === "number" ? parsed.obtainedAt : 0,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeTokenRecord(tokenFile: string, record: XTokenRecord): Promise<void> {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const tmp = `${tokenFile}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmp, tokenFile);
}

export async function deleteTokenRecord(tokenFile: string): Promise<boolean> {
  try {
    await fs.unlink(tokenFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export function buildClientAuthHeaders(account: Pick<XAccountConfig, "clientId" | "clientSecret">) {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (account.clientSecret) {
    const basic = Buffer.from(`${account.clientId}:${account.clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

export function tokenResponseToRecord(
  payload: TokenResponse,
  previous?: Partial<XTokenRecord> | null,
  now = Date.now(),
): XTokenRecord {
  if (!payload.access_token) {
    throw new Error(
      `X token endpoint returned no access_token (${payload.error ?? "unknown"}: ${payload.error_description ?? ""})`,
    );
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? previous?.refreshToken,
    expiresAt: now + expiresIn * 1000,
    scope: payload.scope ?? previous?.scope,
    userId: previous?.userId,
    username: previous?.username,
    obtainedAt: now,
  };
}

export async function refreshAccessToken(params: {
  account: XAccountConfig;
  record: XTokenRecord;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<XTokenRecord> {
  if (!params.record.refreshToken) {
    throw new Error(
      "X access token expired and no refresh token is stored; run `bitterbot x login`",
    );
  }
  const fetcher = params.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.record.refreshToken,
    client_id: params.account.clientId,
  });
  const res = await fetcher(X_TOKEN_URL, {
    method: "POST",
    headers: buildClientAuthHeaders(params.account),
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new Error(
      `X token refresh failed (${res.status}): ${payload.error_description ?? payload.error ?? res.statusText}. Run \`bitterbot x login\` to re-authorize.`,
    );
  }
  return tokenResponseToRecord(payload, params.record, params.now);
}

export type ResolvedAccessToken = {
  token: string;
  source: TokenSource;
  record: XTokenRecord | null;
  tokenFile: string;
};

/**
 * Return a usable access token, refreshing (and persisting) first if it
 * expires within 5 minutes. Serialized per token file so the gateway and a
 * concurrent CLI call can't both rotate the refresh token.
 */
export async function getValidAccessToken(params: {
  account: XAccountConfig;
  accountId: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<ResolvedAccessToken> {
  const env = params.env ?? process.env;
  const tokenFile = resolveTokenFilePath({
    accountId: params.accountId,
    override: params.account.tokenFile,
    env,
  });
  const now = params.now ?? Date.now();

  return withFileLock(
    tokenFile,
    { retries: { retries: 30, factor: 1.5, minTimeout: 50, maxTimeout: 500 }, stale: 30_000 },
    async () => {
      const record = await readTokenRecord(tokenFile);
      if (record) {
        if (record.expiresAt - REFRESH_SKEW_MS > now) {
          return { token: record.accessToken, source: "file", record, tokenFile };
        }
        const refreshed = await refreshAccessToken({
          account: params.account,
          record,
          fetchImpl: params.fetchImpl,
          now,
        });
        await writeTokenRecord(tokenFile, refreshed);
        return { token: refreshed.accessToken, source: "file", record: refreshed, tokenFile };
      }
      const envToken =
        params.accountId === DEFAULT_ACCOUNT_ID ? env.BITTERBOT_X_ACCESS_TOKEN?.trim() : undefined;
      if (envToken) {
        return { token: envToken, source: "env", record: null, tokenFile };
      }
      return { token: "", source: "none", record: null, tokenFile };
    },
  );
}
