/**
 * Minimal X API v2 client: create post, delete post, users/me. Bearer token
 * user context only. One automatic retry on 401 after a forced refresh.
 */

import type { XAccountConfig } from "./types.js";
import {
  getValidAccessToken,
  readTokenRecord,
  refreshAccessToken,
  writeTokenRecord,
} from "./token-store.js";

export const X_API_BASE = "https://api.x.com/2";

export type XApiError = Error & { status?: number; detail?: string; rateLimitResetAt?: number };

export type CreatePostResult = { id: string; text: string; url: string };
export type XUser = { id: string; username: string; name?: string };

type ApiDeps = {
  account: XAccountConfig;
  accountId: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function makeError(message: string, status?: number, detail?: string, resetAt?: number): XApiError {
  const err = new Error(message) as XApiError;
  err.status = status;
  err.detail = detail;
  err.rateLimitResetAt = resetAt;
  return err;
}

async function request<T>(
  deps: ApiDeps,
  init: { method: string; path: string; body?: unknown },
  attempt = 0,
): Promise<T> {
  const fetcher = deps.fetchImpl ?? fetch;
  const resolved = await getValidAccessToken({
    account: deps.account,
    accountId: deps.accountId,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
  });
  if (!resolved.token) {
    throw makeError("X account is not authorized; run `bitterbot x login`", 401);
  }
  const res = await fetcher(`${X_API_BASE}${init.path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${resolved.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "bitterbot-x/1.0",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    return payload as T;
  }

  const detail =
    (typeof payload.detail === "string" && payload.detail) ||
    (Array.isArray(payload.errors) && payload.errors.length > 0
      ? String(
          (payload.errors[0] as Record<string, unknown>).message ??
            JSON.stringify(payload.errors[0]),
        )
      : undefined) ||
    (typeof payload.title === "string" ? payload.title : res.statusText);

  if (res.status === 401 && attempt === 0 && resolved.record?.refreshToken) {
    const current = await readTokenRecord(resolved.tokenFile);
    if (current) {
      const refreshed = await refreshAccessToken({
        account: deps.account,
        record: current,
        fetchImpl: deps.fetchImpl,
      });
      await writeTokenRecord(resolved.tokenFile, refreshed);
      return request<T>(deps, init, attempt + 1);
    }
  }
  if (res.status === 429) {
    const reset = Number(
      res.headers.get("x-rate-limit-reset") ?? res.headers.get("x-user-limit-24hour-reset"),
    );
    const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
    throw makeError(
      `X rate limit hit${resetAt ? `; resets ${new Date(resetAt).toISOString()}` : ""}`,
      429,
      detail,
      resetAt,
    );
  }
  throw makeError(
    `X API ${init.method} ${init.path} failed (${res.status}): ${detail}`,
    res.status,
    detail,
  );
}

export function buildPostUrl(username: string | undefined, id: string): string {
  return `https://x.com/${username ?? "i"}/status/${id}`;
}

export async function createPost(
  deps: ApiDeps,
  params: { text: string; replyToId?: string | null; username?: string },
): Promise<CreatePostResult> {
  const body: Record<string, unknown> = { text: params.text };
  if (params.replyToId) {
    body.reply = { in_reply_to_tweet_id: params.replyToId };
  }
  const payload = await request<{ data?: { id?: string; text?: string } }>(deps, {
    method: "POST",
    path: "/tweets",
    body,
  });
  const id = payload.data?.id;
  if (!id) {
    throw makeError("X API returned no post id", 502, JSON.stringify(payload));
  }
  return { id, text: payload.data?.text ?? params.text, url: buildPostUrl(params.username, id) };
}

export async function deletePost(deps: ApiDeps, id: string): Promise<boolean> {
  const payload = await request<{ data?: { deleted?: boolean } }>(deps, {
    method: "DELETE",
    path: `/tweets/${encodeURIComponent(id)}`,
  });
  return payload.data?.deleted === true;
}

/** Billed user read (about $0.01). Only called explicitly, never from status probes. */
export async function getMe(deps: ApiDeps): Promise<XUser> {
  const payload = await request<{ data?: { id?: string; username?: string; name?: string } }>(
    deps,
    {
      method: "GET",
      path: "/users/me",
    },
  );
  if (!payload.data?.id || !payload.data.username) {
    throw makeError("X API users/me returned no user", 502, JSON.stringify(payload));
  }
  return { id: payload.data.id, username: payload.data.username, name: payload.data.name };
}
