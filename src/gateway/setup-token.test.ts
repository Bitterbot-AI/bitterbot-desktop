import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { isSetupPageRequest } from "./server-http.js";
import { authorizeGatewayMethod } from "./server-methods.js";
import { decideSetupConnect } from "./server/ws-connection/setup-connect.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  isSetupOnlyScopes,
  issueSetupToken,
  revokeSetupToken,
  SETUP_SCOPE,
  SETUP_TOKEN_FILE,
  SETUP_TOKEN_TTL_MS,
  setupTokenLive,
  setupTokenRequestAllowed,
  verifySetupToken,
} from "./setup-token.js";

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-setup-token-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("setup token store", () => {
  it("stores only a hash, 0600, and verifies the token it minted", () => {
    const { token, expiresAt } = issueSetupToken({ stateDir, now: 1_000 });
    expect(expiresAt).toBe(1_000 + SETUP_TOKEN_TTL_MS);
    const raw = fs.readFileSync(path.join(stateDir, SETUP_TOKEN_FILE), "utf8");
    expect(raw).not.toContain(token);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(stateDir, SETUP_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(verifySetupToken(token, { stateDir, now: 2_000 })).toEqual({ ok: true, expiresAt });
  });

  it("rejects a wrong, empty or missing token", () => {
    issueSetupToken({ stateDir });
    expect(verifySetupToken("nope", { stateDir })).toEqual({ ok: false, reason: "invalid" });
    expect(verifySetupToken("", { stateDir })).toEqual({ ok: false, reason: "missing" });
    expect(verifySetupToken(undefined, { stateDir })).toEqual({ ok: false, reason: "missing" });
  });

  it("expires after the TTL (30 minutes by default)", () => {
    const { token } = issueSetupToken({ stateDir, now: 0 });
    expect(verifySetupToken(token, { stateDir, now: SETUP_TOKEN_TTL_MS - 1 }).ok).toBe(true);
    expect(verifySetupToken(token, { stateDir, now: SETUP_TOKEN_TTL_MS })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(SETUP_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect(setupTokenLive({ stateDir, now: SETUP_TOKEN_TTL_MS })).toBe(false);
  });

  it("is single-use: revoked on completion, and a new mint replaces the old token", () => {
    const first = issueSetupToken({ stateDir }).token;
    const second = issueSetupToken({ stateDir }).token;
    expect(verifySetupToken(first, { stateDir }).ok).toBe(false);
    expect(verifySetupToken(second, { stateDir }).ok).toBe(true);
    revokeSetupToken({ stateDir });
    expect(verifySetupToken(second, { stateDir })).toEqual({ ok: false, reason: "invalid" });
    expect(setupTokenLive({ stateDir })).toBe(false);
  });
});

describe("where a setup token is accepted", () => {
  const base = { remoteIsLoopback: true, hasProxyHeaders: false, inContainer: false };

  it("needs a loopback Host header (DNS rebinding) and no proxy headers", () => {
    expect(setupTokenRequestAllowed({ ...base, hostHeader: "127.0.0.1:19001" })).toBe(true);
    expect(setupTokenRequestAllowed({ ...base, hostHeader: "localhost:19001" })).toBe(true);
    expect(setupTokenRequestAllowed({ ...base, hostHeader: "[::1]:19001" })).toBe(true);
    expect(setupTokenRequestAllowed({ ...base, hostHeader: "evil.example:19001" })).toBe(false);
    expect(setupTokenRequestAllowed({ ...base, hostHeader: "192.168.1.5:19001" })).toBe(false);
    expect(setupTokenRequestAllowed({ ...base, hostHeader: undefined })).toBe(false);
    expect(
      setupTokenRequestAllowed({ ...base, hostHeader: "127.0.0.1", hasProxyHeaders: true }),
    ).toBe(false);
  });

  it("needs a loopback socket, except through a container's port mapping", () => {
    const remote = { ...base, remoteIsLoopback: false, hostHeader: "127.0.0.1:19001" };
    expect(setupTokenRequestAllowed(remote)).toBe(false);
    expect(setupTokenRequestAllowed({ ...remote, inContainer: true })).toBe(true);
  });

  it("decideSetupConnect checks role, place and token", async () => {
    const { token } = issueSetupToken({ stateDir });
    const ok = {
      token,
      hostHeader: "127.0.0.1:19001",
      remoteIsLoopback: true,
      hasProxyHeaders: false,
      role: "operator",
      inContainer: false,
      stateDir,
    };
    expect(await decideSetupConnect(ok)).toEqual({ ok: true });
    expect((await decideSetupConnect({ ...ok, role: "node" })).ok).toBe(false);
    expect((await decideSetupConnect({ ...ok, hostHeader: "evil.example" })).ok).toBe(false);
    expect((await decideSetupConnect({ ...ok, token: "forged" })).ok).toBe(false);
    const expired = await decideSetupConnect({ ...ok, now: Date.now() + SETUP_TOKEN_TTL_MS + 1 });
    expect(expired).toMatchObject({ ok: false, reason: "expired" });
  });
});

describe("setup scope", () => {
  const client = (scopes: string[]) => ({
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "bitterbot-control-ui", version: "t", platform: "t", mode: "ui" },
      role: "operator",
      scopes,
    } as never,
  });

  it("is setup-only unless admin is also held", () => {
    expect(isSetupOnlyScopes([SETUP_SCOPE])).toBe(true);
    expect(isSetupOnlyScopes([SETUP_SCOPE, "operator.admin"])).toBe(false);
    expect(isSetupOnlyScopes(["operator.admin"])).toBe(false);
  });

  it("allows the wizard RPCs and nothing else", () => {
    const setup = client([SETUP_SCOPE]);
    for (const method of ["wizard.start", "wizard.next", "wizard.cancel", "wizard.status"]) {
      expect(authorizeGatewayMethod(method, setup)).toBeNull();
    }
    for (const method of [
      "config.get",
      "config.set",
      "chat.send",
      "agent",
      "health",
      "sessions.list",
      "update.run",
      "doctor.findings",
      "models.list",
    ]) {
      expect(authorizeGatewayMethod(method, setup)?.message).toBe(
        "setup token grants wizard access only",
      );
    }
  });

  it("receives no broadcast events except the keepalive tick", () => {
    const sent: string[] = [];
    const socket = {
      bufferedAmount: 0,
      send: (frame: string) => sent.push(frame),
      close: () => {},
    };
    const ws = { socket, connId: "c1", ...client([SETUP_SCOPE]) } as unknown as GatewayWsClient;
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([ws]) });
    broadcast("agent", { text: "private" });
    broadcast("chat", { text: "private" });
    broadcast("presence", {});
    broadcast("tick", { ts: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"event":"tick"');
  });
});

describe("setup page over HTTP (non-loopback socket, e.g. Docker port mapping)", () => {
  const req = (url: string, host = "127.0.0.1:19001") =>
    ({ url, headers: { host } }) as unknown as import("node:http").IncomingMessage;

  it("serves /setup only with a live token and a loopback Host", () => {
    const { token } = issueSetupToken({ stateDir });
    expect(isSetupPageRequest(req(`/setup?token=${token}`), "", { stateDir })).toBe(true);
    expect(isSetupPageRequest(req(`/bb/setup?token=${token}`), "/bb", { stateDir })).toBe(true);
    expect(isSetupPageRequest(req("/setup?token=wrong"), "", { stateDir })).toBe(false);
    expect(isSetupPageRequest(req(`/setup?token=${token}`, "evil.example"), "", { stateDir })).toBe(
      false,
    );
  });

  it("serves the bundle's assets only while a setup link is live, never index or auth", () => {
    expect(isSetupPageRequest(req("/assets/index-abc.js"), "", { stateDir })).toBe(false);
    issueSetupToken({ stateDir });
    expect(isSetupPageRequest(req("/assets/index-abc.js"), "", { stateDir })).toBe(true);
    expect(isSetupPageRequest(req("/"), "", { stateDir })).toBe(false);
    expect(isSetupPageRequest(req("/index.html"), "", { stateDir })).toBe(false);
    expect(isSetupPageRequest(req("/auth/session-token"), "", { stateDir })).toBe(false);
  });
});
