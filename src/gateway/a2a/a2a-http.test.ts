import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createA2aHttpHandler } from "./a2a-http.js";

function mockReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  remoteAddr?: string;
}): IncomingMessage {
  const sock = new Socket();
  Object.defineProperty(sock, "remoteAddress", {
    value: opts.remoteAddr ?? "127.0.0.1",
    writable: true,
  });
  const req = new IncomingMessage(sock);
  req.method = opts.method ?? "POST";
  req.url = opts.url ?? "/a2a";
  req.headers = { "content-type": "application/json", ...opts.headers };
  if (opts.body !== undefined) {
    const buf = Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    req.push(buf);
    req.push(null);
    req.headers["content-length"] = String(buf.byteLength);
  } else {
    req.push(null);
  }
  return req;
}

function mockRes(): ServerResponse & { _body?: string; _headers: Record<string, string> } {
  const sock = new Socket();
  const res = new ServerResponse(new IncomingMessage(sock)) as ServerResponse & {
    _body?: string;
    _headers: Record<string, string>;
  };
  res._headers = {};
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | readonly string[]) => {
    res._headers[name.toLowerCase()] = String(value);
    return origSetHeader(name, value as string);
  }) as typeof res.setHeader;
  let buf = "";
  res.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: string | Uint8Array) => {
    if (chunk) {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    }
    res._body = buf;
    return res;
  }) as typeof res.end;
  return res;
}

const baseConfig = () =>
  ({
    a2a: { enabled: true, authentication: { type: "none" as const } },
  }) as never;

const baseAuthOpts = () => ({
  auth: {} as never,
  trustedProxies: [],
  rateLimiter: undefined,
});

function makeHandler() {
  return createA2aHttpHandler({
    getConfig: baseConfig,
    getSkills: () => [],
    getGatewayUrl: () => "http://127.0.0.1:19001",
    getSkillsVersion: () => 0,
    taskDb: new DatabaseSync(":memory:"),
  });
}

describe("createA2aHttpHandler", () => {
  it("serves the agent card at /.well-known/agent.json without auth", async () => {
    const h = makeHandler();
    const req = mockReq({ method: "GET", url: "/.well-known/agent.json" });
    const res = mockRes();
    const handled = await h.handle(req, res, baseAuthOpts());
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const card = JSON.parse(res._body ?? "{}");
    expect(card.url).toBe("http://127.0.0.1:19001/a2a");
    h.close();
  });

  it("returns 405 when /a2a is hit with non-POST", async () => {
    const h = makeHandler();
    const req = mockReq({ method: "GET", url: "/a2a" });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(405);
    expect(res._headers.allow).toBe("POST");
    h.close();
  });

  it("returns false (not handled) for paths that aren't A2A", async () => {
    const h = makeHandler();
    const req = mockReq({ method: "POST", url: "/something-else" });
    const res = mockRes();
    const handled = await h.handle(req, res, baseAuthOpts());
    expect(handled).toBe(false);
    h.close();
  });

  it("accepts a JSON-RPC request and returns a working task", async () => {
    const h = makeHandler();
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        id: "abc",
      },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body ?? "{}");
    expect(body.id).toBe("abc");
    expect(body.result.status.state).toBe("working");
    h.close();
  });

  it("treats a JSON-RPC notification (no id) as fire-and-forget with 204", async () => {
    const h = makeHandler();
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "notification/probe",
        // intentionally no id
      },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(204);
    expect(res._body).toBe("");
    h.close();
  });

  it("accepts numeric id 0 as a valid request id (regression for !id falsy bug)", async () => {
    const h = makeHandler();
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        id: 0,
      },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res._body ?? "{}");
    expect(body.id).toBe(0);
    h.close();
  });

  it("handler.close() releases its DB handle without throwing on subsequent calls", () => {
    const h = makeHandler();
    h.close();
    expect(() => h.close()).not.toThrow();
  });
});

describe("createA2aHttpHandler — auth", () => {
  it("rejects non-loopback request with no token (401-equivalent)", async () => {
    const h = createA2aHttpHandler({
      getConfig: () =>
        ({
          a2a: {
            enabled: true,
            authentication: { type: "bearer", bearerToken: "secret" },
          },
        }) as never,
      getSkills: () => [],
      getGatewayUrl: () => "http://example.com:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "x" }] } },
        id: "1",
      },
      remoteAddr: "8.8.8.8",
      headers: { "x-forwarded-for": "" },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(401);
    h.close();
  });

  it("accepts non-loopback request with the configured bearer token", async () => {
    const h = createA2aHttpHandler({
      getConfig: () =>
        ({
          a2a: {
            enabled: true,
            authentication: { type: "bearer", bearerToken: "secret" },
          },
        }) as never,
      getSkills: () => [],
      getGatewayUrl: () => "http://example.com:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "x" }] } },
        id: "1",
      },
      remoteAddr: "8.8.8.8",
      headers: { authorization: "Bearer secret" },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(200);
    h.close();
  });

  // PLAN-29: forage/* verbs are exempt from bearer auth BY DESIGN — hunters
  // are anonymous peers gated on funding/caps/scanning, not identity. An
  // unauthenticated remote call must get past auth and reach the forage
  // dispatcher (503 bounty-directory-unavailable in this harness, since no
  // memory manager exists — the point is it is NOT a 401).
  it("serves forage/* verbs to unauthenticated non-loopback callers", async () => {
    const h = createA2aHttpHandler({
      getConfig: () =>
        ({
          a2a: {
            enabled: true,
            authentication: { type: "bearer", bearerToken: "secret" },
          },
        }) as never,
      getSkills: () => [],
      getGatewayUrl: () => "http://example.com:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: {
        jsonrpc: "2.0",
        method: "forage/claim",
        params: { bountyId: "nope", hunterPubkey: "pk", hunterWallet: "0x1" },
        id: "1",
      },
      remoteAddr: "8.8.8.8",
      headers: { "x-forwarded-for": "" },
    });
    const res = mockRes();
    const handled = await h.handle(req, res, baseAuthOpts());
    expect(handled).toBe(true);
    expect(res.statusCode).not.toBe(401);
    h.close();
  });

  it("still rejects non-forage verbs without a token after the forage exemption", async () => {
    const h = createA2aHttpHandler({
      getConfig: () =>
        ({
          a2a: {
            enabled: true,
            authentication: { type: "bearer", bearerToken: "secret" },
          },
        }) as never,
      getSkills: () => [],
      getGatewayUrl: () => "http://example.com:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: { jsonrpc: "2.0", method: "tasks/get", params: { id: "t1" }, id: "1" },
      remoteAddr: "8.8.8.8",
      headers: { "x-forwarded-for": "" },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    expect(res.statusCode).toBe(401);
    h.close();
  });
});

describe("createA2aHttpHandler — circle/mailbox kill switch (PLAN-31 §8)", () => {
  function handlerWith(circles?: Record<string, unknown>) {
    return createA2aHttpHandler({
      getConfig: () =>
        ({
          a2a: { enabled: true, authentication: { type: "none" as const } },
          ...(circles ? { circles } : {}),
        }) as never,
      getSkills: () => [],
      getGatewayUrl: () => "http://127.0.0.1:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
  }

  async function call(h: ReturnType<typeof createA2aHttpHandler>, method: string) {
    const req = mockReq({
      method: "POST",
      url: "/a2a",
      body: { jsonrpc: "2.0", method, params: {}, id: "1" },
    });
    const res = mockRes();
    await h.handle(req, res, baseAuthOpts());
    return { status: res.statusCode, body: JSON.parse(res._body ?? "{}") };
  }

  it("answers METHOD_NOT_FOUND for every circle/* verb when circles are disabled", async () => {
    // Default config has no circles block: the surface must be INVISIBLE,
    // indistinguishable from a node without the feature.
    const h = handlerWith();
    for (const method of [
      "circle/join",
      "circle/roster",
      "circle/message",
      "circle/event.append",
    ]) {
      const { status, body } = await call(h, method);
      expect(status, method).toBe(404);
      expect(body.error?.message).toBe("Method not found");
    }
    h.close();
  });

  it("answers METHOD_NOT_FOUND for mailbox/* unless BOTH circles.enabled and mailbox.serve are true", async () => {
    // circles on, serve off: still invisible.
    const h = handlerWith({ enabled: true, mailbox: { serve: false } });
    const { status } = await call(h, "mailbox/post");
    expect(status).toBe(404);
    h.close();

    // circles off entirely: invisible.
    const h2 = handlerWith({ enabled: false, mailbox: { serve: true } });
    const { status: s2 } = await call(h2, "mailbox/poll");
    expect(s2).toBe(404);
    h2.close();
  });

  it("explicit circles.enabled=false matches the missing-config shape exactly", async () => {
    const off = handlerWith({ enabled: false });
    const missing = handlerWith();
    const a = await call(off, "circle/roster");
    const b = await call(missing, "circle/roster");
    expect(a.status).toBe(b.status);
    expect(a.body.error).toEqual(b.body.error);
    off.close();
    missing.close();
  });
});
