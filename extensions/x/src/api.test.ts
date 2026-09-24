import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XAccountConfig } from "./types.js";
import { createPost, deletePost, getMe } from "./api.js";
import { readTokenRecord, writeTokenRecord } from "./token-store.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("x api", () => {
  let dir: string;
  let account: XAccountConfig;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-api-"));
    account = { clientId: "cid", tokenFile: path.join(dir, "t.json") };
    await writeTokenRecord(account.tokenFile!, {
      accessToken: "tok",
      refreshToken: "r1",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: 0,
      username: "bot",
    });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a post with bearer auth and returns the permalink", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.x.com/2/tweets");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect(JSON.parse(String(init.body))).toEqual({ text: "hello" });
      return jsonResponse({ data: { id: "1", text: "hello" } }, 201);
    });
    const res = await createPost(
      { account, accountId: "default", fetchImpl: fetchImpl as unknown as typeof fetch },
      { text: "hello", username: "bot" },
    );
    expect(res).toEqual({ id: "1", text: "hello", url: "https://x.com/bot/status/1" });
  });

  it("adds the reply block when replying", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({
        text: "hi",
        reply: { in_reply_to_tweet_id: "99" },
      });
      return jsonResponse({ data: { id: "2", text: "hi" } }, 201);
    });
    await createPost(
      { account, accountId: "default", fetchImpl: fetchImpl as unknown as typeof fetch },
      { text: "hi", replyToId: "99" },
    );
  });

  it("refreshes once on 401 and retries", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls += 1;
      if (url.endsWith("/oauth2/token")) {
        return jsonResponse({ access_token: "tok2", refresh_token: "r2", expires_in: 7200 });
      }
      if (calls === 1) {
        return jsonResponse({ title: "Unauthorized" }, 401);
      }
      return jsonResponse({ data: { id: "3", text: "ok" } }, 201);
    });
    const res = await createPost(
      { account, accountId: "default", fetchImpl: fetchImpl as unknown as typeof fetch },
      { text: "ok" },
    );
    expect(res.id).toBe("3");
    expect((await readTokenRecord(account.tokenFile!))?.accessToken).toBe("tok2");
  });

  it("maps 403 duplicate and 429 rate limit errors", async () => {
    const dup = vi.fn(async () =>
      jsonResponse(
        { detail: "You are not allowed to create a Tweet with duplicate content." },
        403,
      ),
    );
    await expect(
      createPost(
        { account, accountId: "default", fetchImpl: dup as unknown as typeof fetch },
        { text: "x" },
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/duplicate content/),
    });
    const limited = vi.fn(async () =>
      jsonResponse({ title: "Too Many Requests" }, 429, { "x-rate-limit-reset": "1800000000" }),
    );
    await expect(
      createPost(
        { account, accountId: "default", fetchImpl: limited as unknown as typeof fetch },
        { text: "x" },
      ),
    ).rejects.toMatchObject({
      status: 429,
      rateLimitResetAt: 1_800_000_000_000,
    });
  });

  it("deletePost and getMe", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        expect(url).toBe("https://api.x.com/2/tweets/5");
        return jsonResponse({ data: { deleted: true } });
      }
      expect(url).toBe("https://api.x.com/2/users/me");
      return jsonResponse({ data: { id: "42", username: "bot", name: "Bitterbot" } });
    });
    const deps = { account, accountId: "default", fetchImpl: fetchImpl as unknown as typeof fetch };
    expect(await deletePost(deps, "5")).toBe(true);
    expect(await getMe(deps)).toEqual({ id: "42", username: "bot", name: "Bitterbot" });
  });

  it("fails clearly when not authorized", async () => {
    await fs.rm(account.tokenFile!);
    await expect(createPost({ account, accountId: "other" }, { text: "x" })).rejects.toThrow(
      /bitterbot x login/,
    );
  });
});
