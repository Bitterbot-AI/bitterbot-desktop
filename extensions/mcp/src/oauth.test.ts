import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileOAuthProvider, stateMatches } from "./oauth.js";

const make = async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "mcp-oauth-")), "srv.json");
  return {
    file,
    provider: new FileOAuthProvider(file, "http://127.0.0.1:19001/mcp/oauth/callback"),
  };
};

describe("FileOAuthProvider", () => {
  it("keeps sign-in state in a private file", async () => {
    const { file, provider } = await make();
    provider.saveCodeVerifier("v1");
    const state = provider.state();
    provider.saveClientInformation({ client_id: "abc" });

    expect(provider.codeVerifier()).toBe("v1");
    expect(provider.clientInformation()).toEqual({ client_id: "abc" });
    expect(provider.savedState()).toBe(state);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("spends the state once tokens arrive, and signs out cleanly", async () => {
    const { provider } = await make();
    provider.state();
    provider.saveTokens({ access_token: "t", token_type: "Bearer" });

    expect(provider.signedIn()).toBe(true);
    expect(provider.savedState()).toBeUndefined();
    provider.signOut();
    expect(provider.signedIn()).toBe(false);
  });

  it("describes itself as a public client with the gateway callback", async () => {
    const { provider } = await make();
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Bitterbot",
      redirect_uris: ["http://127.0.0.1:19001/mcp/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
  });
});

describe("stateMatches", () => {
  it("accepts only the exact state issued", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    expect(stateMatches(undefined, "abc")).toBe(false);
  });
});
