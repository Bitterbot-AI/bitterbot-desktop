/**
 * PLAN-43 Phase 1 (R1), HTTP-level: the trust wiring in a2a-http. Under
 * a2a.authentication "none", a REMOTE caller reaches dispatch but is NOT
 * trusted — task reads need the per-task access token. A regression that
 * hardcodes callerTrusted true would pass the server-level unit tests;
 * this test pins the wiring itself.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createA2aHttpHandler } from "./a2a-http.js";

function mockReq(opts: { body?: unknown; remoteAddress?: string }): IncomingMessage {
  const sock = new Socket();
  Object.defineProperty(sock, "remoteAddress", {
    value: opts.remoteAddress ?? "203.0.113.9",
    writable: true,
  });
  const req = new IncomingMessage(sock);
  req.method = "POST";
  req.url = "/a2a";
  req.headers = { "content-type": "application/json", host: "a2a.example.com" };
  const buf = Buffer.from(JSON.stringify(opts.body));
  req.push(buf);
  req.push(null);
  req.headers["content-length"] = String(buf.byteLength);
  return req;
}

function mockRes(): ServerResponse & { _body?: string } {
  const sock = new Socket();
  const res = new ServerResponse(new IncomingMessage(sock)) as ServerResponse & {
    _body?: string;
  };
  let buf = "";
  res.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: string | Uint8Array) => {
    if (chunk) buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    res._body = buf;
    return res;
  }) as typeof res.end;
  return res;
}

const CONFIG = {
  a2a: { enabled: true, authentication: { type: "none" } },
} as never;

async function rpc(
  h: ReturnType<typeof createA2aHttpHandler>,
  body: unknown,
  remoteAddress?: string,
): Promise<{ status: number; json: { result?: unknown; error?: { code?: number } } }> {
  const req = mockReq({ body, remoteAddress });
  const res = mockRes();
  await h.handle(req, res, { auth: {} as never, trustedProxies: [], rateLimiter: undefined });
  return { status: res.statusCode, json: JSON.parse(res._body ?? "{}") };
}

describe("a2a-http task access trust wiring", () => {
  it("a remote caller under auth 'none' needs the access token; a wrong one is NOT_FOUND", async () => {
    const h = createA2aHttpHandler({
      getConfig: () => CONFIG,
      getSkills: () => [],
      getGatewayUrl: () => "http://127.0.0.1:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    try {
      const created = await rpc(h, {
        jsonrpc: "2.0",
        method: "message/send",
        params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
        id: "1",
      });
      const task = created.json.result as { id: string; accessToken?: string };
      expect(task.id).toBeTruthy();
      expect(task.accessToken).toMatch(/^[0-9a-f]{32}$/);

      const noToken = await rpc(h, {
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: task.id },
        id: "2",
      });
      expect(noToken.status).toBe(404);

      const withToken = await rpc(h, {
        jsonrpc: "2.0",
        method: "tasks/get",
        params: { id: task.id, accessToken: task.accessToken },
        id: "3",
      });
      expect(withToken.status).toBe(200);
      expect((withToken.json.result as { id?: string }).id).toBe(task.id);

      const list = await rpc(h, {
        jsonrpc: "2.0",
        method: "tasks/list",
        params: {},
        id: "4",
      });
      expect(list.status).toBe(401);
    } finally {
      h.close();
    }
  });

  it("a local direct caller is trusted (no token needed)", async () => {
    const h = createA2aHttpHandler({
      getConfig: () => CONFIG,
      getSkills: () => [],
      getGatewayUrl: () => "http://127.0.0.1:19001",
      getSkillsVersion: () => 0,
      taskDb: new DatabaseSync(":memory:"),
    });
    try {
      const created = await rpc(
        h,
        {
          jsonrpc: "2.0",
          method: "message/send",
          params: { message: { role: "user", parts: [{ type: "text", text: "hi" }] } },
          id: "1",
        },
        "127.0.0.1",
      );
      const task = created.json.result as { id: string };

      const req = mockReq({
        body: { jsonrpc: "2.0", method: "tasks/get", params: { id: task.id }, id: "2" },
        remoteAddress: "127.0.0.1",
      });
      req.headers.host = "127.0.0.1:19001";
      const res = mockRes();
      await h.handle(req, res, { auth: {} as never, trustedProxies: [], rateLimiter: undefined });
      expect(res.statusCode).toBe(200);
    } finally {
      h.close();
    }
  });
});
