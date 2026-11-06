import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleMobileHttpRequest,
  isPublicMobileAssetPath,
  isSameOriginPost,
  resetMobileHttpRateLimitsForTests,
} from "./http.js";
import {
  buildClaimSignaturePayload,
  createSetupCode,
  resetMobilePairingForTests,
} from "./pairing.js";

type FakeRes = ServerResponse & { body: string; headersOut: Record<string, string> };

function fakeReq(params: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const raw = params.body === undefined ? "" : JSON.stringify(params.body);
  const stream = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  Object.assign(stream, {
    method: params.method ?? "GET",
    url: params.url,
    headers: { host: "phone.test:19001", ...params.headers },
    socket: { remoteAddress: "192.168.1.30" },
  });
  return stream;
}

function fakeRes(): FakeRes {
  const headersOut: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: "",
    headersOut,
    setHeader(name: string, value: string) {
      headersOut[name.toLowerCase()] = String(value);
    },
    end(chunk?: string) {
      res.body = chunk ?? "";
    },
  };
  return res as unknown as FakeRes;
}

const opts = { basePath: "", enabled: true, trustedProxies: [] as string[] };

let stateDir = "";
let prev: string | undefined;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-mobile-http-"));
  prev = process.env.BITTERBOT_STATE_DIR;
  process.env.BITTERBOT_STATE_DIR = stateDir;
  resetMobilePairingForTests();
  resetMobileHttpRateLimitsForTests();
});
afterEach(async () => {
  if (prev === undefined) delete process.env.BITTERBOT_STATE_DIR;
  else process.env.BITTERBOT_STATE_DIR = prev;
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("phone app HTTP (PLAN-62)", () => {
  it("redirects /m to /m/ (the service worker scope), keeping the query", async () => {
    const res = fakeRes();
    expect(await handleMobileHttpRequest(fakeReq({ url: "/m?x=1" }), res, opts)).toBe(true);
    expect(res.statusCode).toBe(302);
    expect(res.headersOut.location).toBe("/m/?x=1");
  });

  it("leaves other paths alone", async () => {
    expect(await handleMobileHttpRequest(fakeReq({ url: "/management" }), fakeRes(), opts)).toBe(
      false,
    );
    expect(await handleMobileHttpRequest(fakeReq({ url: "/mobile" }), fakeRes(), opts)).toBe(false);
  });

  it("refuses non-JSON and cross-site posts to the pairing API", async () => {
    const formPost = fakeRes();
    await handleMobileHttpRequest(
      fakeReq({
        method: "POST",
        url: "/m/api/pair/claim",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      formPost,
      opts,
    );
    expect(formPost.statusCode).toBe(415);

    const foreign = fakeRes();
    await handleMobileHttpRequest(
      fakeReq({
        method: "POST",
        url: "/m/api/pair/claim",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: {},
      }),
      foreign,
      opts,
    );
    expect(foreign.statusCode).toBe(403);
  });

  it("claims a code end to end over HTTP and reports pending status", async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const id = crypto.createHash("sha256").update(raw).digest("hex");
    const { code } = createSetupCode();
    const signedAt = Date.now();
    const signature = crypto
      .sign(
        null,
        Buffer.from(buildClaimSignaturePayload({ code, deviceId: id, signedAtMs: signedAt })),
        privateKey,
      )
      .toString("base64url");
    const res = fakeRes();
    await handleMobileHttpRequest(
      fakeReq({
        method: "POST",
        url: "/m/api/pair/claim",
        headers: { "content-type": "application/json", origin: "http://phone.test:19001" },
        body: { code, device: { id, publicKey: raw.toString("base64url"), signature, signedAt } },
      }),
      res,
      opts,
    );
    expect(res.statusCode).toBe(200);
    const claim = JSON.parse(res.body) as { claimId: string; confirmCode: string };
    expect(claim.confirmCode).toMatch(/^\d{6}$/);
    expect(res.headersOut["cache-control"]).toBe("no-store");

    const status = fakeRes();
    await handleMobileHttpRequest(
      fakeReq({
        method: "POST",
        url: "/m/api/pair/status",
        headers: { "content-type": "application/json" },
        body: { claimId: claim.claimId, deviceId: id },
      }),
      status,
      opts,
    );
    expect(JSON.parse(status.body)).toMatchObject({ status: "pending" });
  });

  it("rate limits claims per client", async () => {
    let last = fakeRes();
    for (let i = 0; i < 21; i++) {
      last = fakeRes();
      await handleMobileHttpRequest(
        fakeReq({
          method: "POST",
          url: "/m/api/pair/claim",
          headers: { "content-type": "application/json" },
          body: { code: "x" },
        }),
        last,
        opts,
      );
    }
    expect(last.statusCode).toBe(429);
  });

  it("is off when gateway.mobile.enabled is false", async () => {
    const res = fakeRes();
    await handleMobileHttpRequest(fakeReq({ url: "/m/" }), res, { ...opts, enabled: false });
    expect(res.statusCode).toBe(404);
  });

  it("treats only the phone shell and shared static assets as public", () => {
    expect(isPublicMobileAssetPath("/m/")).toBe(true);
    expect(isPublicMobileAssetPath("/m/sw.js")).toBe(true);
    expect(isPublicMobileAssetPath("/assets/index-abc.js")).toBe(true);
    expect(isPublicMobileAssetPath("/")).toBe(false);
    expect(isPublicMobileAssetPath("/index.html")).toBe(false);
    expect(isPublicMobileAssetPath("/auth/session-token")).toBe(false);
  });

  it("compares Origin with the Host header", () => {
    const same = fakeReq({ url: "/", headers: { origin: "http://phone.test:19001" } });
    const other = fakeReq({ url: "/", headers: { origin: "http://phone.test:9999" } });
    const nullOrigin = fakeReq({ url: "/", headers: { origin: "null" } });
    expect(isSameOriginPost(same)).toBe(true);
    expect(isSameOriginPost(other)).toBe(false);
    expect(isSameOriginPost(nullOrigin)).toBe(false);
  });
});
