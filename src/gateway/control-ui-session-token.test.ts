import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  handleSessionTokenRequest,
  isAllowedHost,
  parseHostHeader,
} from "./control-ui-session-token.js";

const TOKEN = "s3cret-gateway-token";

const makeReq = (headers: Record<string, string> = {}, method = "GET") =>
  ({ method, headers }) as unknown as IncomingMessage;

type FakeRes = ServerResponse & { headers: Record<string, string>; body: string };
const makeRes = (): FakeRes => {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = String(v);
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      }
    },
  };
  return res as unknown as FakeRes;
};

const local = () => true;
const remote = () => false;

describe("session token handoff", () => {
  it("hands the token to a loopback caller with a loopback Host", () => {
    const res = makeRes();
    const handled = handleSessionTokenRequest(makeReq({ host: "127.0.0.1:19001" }), res, {
      token: TOKEN,
      isLocalDirect: local,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: TOKEN });
  });

  it("never allows the token into a cache", () => {
    const res = makeRes();
    handleSessionTokenRequest(makeReq({ host: "localhost:19001" }), res, {
      token: TOKEN,
      isLocalDirect: local,
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses a non-loopback caller", () => {
    const res = makeRes();
    handleSessionTokenRequest(makeReq({ host: "localhost:19001" }), res, {
      token: TOKEN,
      isLocalDirect: remote,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(TOKEN);
  });

  it("refuses a DNS rebinding attempt that passes the socket check", () => {
    // The core reason the Host allowlist exists. After the TTL flips,
    // evil.example resolves to 127.0.0.1 and the victim's browser connects from
    // their own machine, so isLocalDirectRequest is satisfied. Only the Host
    // header distinguishes it.
    const res = makeRes();
    handleSessionTokenRequest(makeReq({ host: "evil.example:19001" }), res, {
      token: TOKEN,
      isLocalDirect: local,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(TOKEN);
  });

  it("refuses a missing or malformed Host", () => {
    for (const headers of [{}, { host: "" }, { host: "a:b:c" }, { host: "[::1" }]) {
      const res = makeRes();
      handleSessionTokenRequest(makeReq(headers), res, { token: TOKEN, isLocalDirect: local });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.body).not.toContain(TOKEN);
    }
  });

  it("accepts operator-configured hosts such as a Tailscale name", () => {
    const res = makeRes();
    handleSessionTokenRequest(makeReq({ host: "my-box.tailnet.ts.net" }), res, {
      token: TOKEN,
      allowedHosts: ["my-box.tailnet.ts.net"],
      isLocalDirect: local,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: TOKEN });
  });

  it("reports null rather than failing when no auth is configured", () => {
    const res = makeRes();
    handleSessionTokenRequest(makeReq({ host: "localhost" }), res, { isLocalDirect: local });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: null });
  });

  it("ignores non-GET methods", () => {
    const res = makeRes();
    expect(
      handleSessionTokenRequest(makeReq({ host: "localhost" }, "POST"), res, {
        token: TOKEN,
        isLocalDirect: local,
      }),
    ).toBe(false);
  });

  it("rejection looks identical regardless of the reason", () => {
    const byOrigin = makeRes();
    handleSessionTokenRequest(makeReq({ host: "localhost" }), byOrigin, {
      token: TOKEN,
      isLocalDirect: remote,
    });
    const byHost = makeRes();
    handleSessionTokenRequest(makeReq({ host: "evil.example" }), byHost, {
      token: TOKEN,
      isLocalDirect: local,
    });
    expect(byOrigin.statusCode).toBe(byHost.statusCode);
    expect(byOrigin.body).toBe(byHost.body);
  });
});

describe("host header parsing", () => {
  it("splits host and port", () => {
    expect(parseHostHeader("localhost:19001")).toEqual({ host: "localhost", port: "19001" });
    expect(parseHostHeader("localhost")).toEqual({ host: "localhost", port: undefined });
  });

  it("handles bracketed IPv6", () => {
    expect(parseHostHeader("[::1]:19001")).toEqual({ host: "[::1]", port: "19001" });
    expect(parseHostHeader("[::1]")).toEqual({ host: "[::1]", port: undefined });
  });

  it("rejects malformed values", () => {
    for (const bad of ["", "   ", "a:b:c", "[::1", undefined]) {
      expect(parseHostHeader(bad), String(bad)).toBeNull();
    }
  });

  it("matches allowed hosts case-insensitively and ignores the port", () => {
    expect(isAllowedHost({ hostHeader: "LOCALHOST:19001" })).toBe(true);
    expect(isAllowedHost({ hostHeader: "[::1]:19001" })).toBe(true);
    expect(isAllowedHost({ hostHeader: "127.0.0.1" })).toBe(true);
    expect(isAllowedHost({ hostHeader: "example.com" })).toBe(false);
    expect(
      isAllowedHost({ hostHeader: "Host.Example:8080", allowedHosts: ["host.example:19001"] }),
    ).toBe(true);
  });

  it("does not treat a lookalike host as loopback", () => {
    for (const host of ["127.0.0.1.evil.com", "localhost.evil.com", "notlocalhost"]) {
      expect(isAllowedHost({ hostHeader: host }), host).toBe(false);
    }
  });
});
