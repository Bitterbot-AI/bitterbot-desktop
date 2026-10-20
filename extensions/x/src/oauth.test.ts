import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  buildRedirectUri,
  exchangeCode,
  generatePkce,
  waitForCallback,
} from "./oauth.js";

describe("oauth", () => {
  it("builds a PKCE authorize url with all four scopes", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier.length).toBeGreaterThan(40);
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        redirectUri: buildRedirectUri(19010),
        state: "st",
        challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("tweet.read tweet.write users.read offline.access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:19010/callback");
  });

  it("exchanges the code with the verifier", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("code_verifier=ver");
      return new Response(
        JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expires_in: 7200,
          scope: "tweet.write",
        }),
        { status: 200 },
      );
    });
    const rec = await exchangeCode({
      account: { clientId: "cid" },
      code: "c",
      verifier: "ver",
      redirectUri: "http://127.0.0.1:19010/callback",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 0,
    });
    expect(rec).toMatchObject({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 7_200_000,
      scope: "tweet.write",
    });
  });

  it("loopback server resolves the code only for the matching state", async () => {
    const port = 19_500 + Math.floor(Math.random() * 400);
    const pending = waitForCallback({ port, state: "good", timeoutMs: 5000 });
    pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const bad = await fetch(`http://127.0.0.1:${port}/callback?state=bad&code=zzz`);
    expect(bad.status).toBe(400);
    await expect(pending).rejects.toThrow(/state mismatch/);

    const pending2 = waitForCallback({ port, state: "good", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const ok = await fetch(`http://127.0.0.1:${port}/callback?state=good&code=abc`);
    expect(ok.status).toBe(200);
    await expect(pending2).resolves.toBe("abc");
  });
});
