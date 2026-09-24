import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XAccountConfig, XTokenRecord } from "./types.js";
import {
  buildClientAuthHeaders,
  getValidAccessToken,
  readTokenRecord,
  tokenResponseToRecord,
  writeTokenRecord,
} from "./token-store.js";

const account: XAccountConfig = { clientId: "cid", clientSecret: "sec" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("token store", () => {
  let dir: string;
  let tokenFile: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "x-token-"));
    tokenFile = path.join(dir, "default.token.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("writes 0600 and round-trips", async () => {
    const record: XTokenRecord = {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
      obtainedAt: 0,
    };
    await writeTokenRecord(tokenFile, record);
    const stat = await fs.stat(tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await readTokenRecord(tokenFile)).toEqual(record);
    expect(await readTokenRecord(path.join(dir, "missing.json"))).toBeNull();
  });

  it("uses basic auth only for confidential clients", () => {
    expect(buildClientAuthHeaders({ clientId: "cid" }).Authorization).toBeUndefined();
    expect(buildClientAuthHeaders(account).Authorization).toBe(
      `Basic ${Buffer.from("cid:sec").toString("base64")}`,
    );
  });

  it("tokenResponseToRecord keeps the previous refresh token and identity when omitted", () => {
    const rec = tokenResponseToRecord(
      { access_token: "new", expires_in: 100 },
      { refreshToken: "old-r", username: "bot", userId: "1" },
      1000,
    );
    expect(rec).toMatchObject({
      accessToken: "new",
      refreshToken: "old-r",
      username: "bot",
      userId: "1",
      expiresAt: 101_000,
    });
    expect(() => tokenResponseToRecord({ error: "invalid_grant" })).toThrow(/invalid_grant/);
  });

  it("returns the stored token when fresh, without network", async () => {
    await writeTokenRecord(tokenFile, {
      accessToken: "fresh",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      obtainedAt: 0,
    });
    const fetchImpl = vi.fn();
    const res = await getValidAccessToken({
      account: { ...account, tokenFile },
      accountId: "default",
      fetchImpl,
    });
    expect(res).toMatchObject({ token: "fresh", source: "file" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token and persists the rotated refresh token before returning", async () => {
    await writeTokenRecord(tokenFile, {
      accessToken: "stale",
      refreshToken: "r1",
      expiresAt: Date.now() + 60_000,
      obtainedAt: 0,
      username: "bot",
    });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=r1");
      expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
      return jsonResponse({ access_token: "a2", refresh_token: "r2", expires_in: 7200 });
    });
    const res = await getValidAccessToken({
      account: { ...account, tokenFile },
      accountId: "default",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.token).toBe("a2");
    const onDisk = await readTokenRecord(tokenFile);
    expect(onDisk?.refreshToken).toBe("r2");
    expect(onDisk?.username).toBe("bot");
  });

  it("surfaces refresh failures with a re-login hint", async () => {
    await writeTokenRecord(tokenFile, {
      accessToken: "stale",
      refreshToken: "r1",
      expiresAt: 0,
      obtainedAt: 0,
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "invalid_request", error_description: "revoked" }, 400),
    );
    await expect(
      getValidAccessToken({
        account: { ...account, tokenFile },
        accountId: "default",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/revoked.*bitterbot x login/);
  });

  it("falls back to the env token for the default account only", async () => {
    vi.stubEnv("BITTERBOT_X_ACCESS_TOKEN", "env-token");
    const def = await getValidAccessToken({
      account: { ...account, tokenFile },
      accountId: "default",
    });
    expect(def).toMatchObject({ token: "env-token", source: "env" });
    const other = await getValidAccessToken({
      account: { ...account, tokenFile: path.join(dir, "o.json") },
      accountId: "other",
    });
    expect(other).toMatchObject({ token: "", source: "none" });
  });
});
