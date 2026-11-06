import crypto from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

// Kept inline (not imported from ./mobile/*) so nothing pulls gateway modules in
// before the test helpers install their mocks.
const MOBILE_CLIENT_ID = "bitterbot-mobile";
const MOBILE_DEVICE_SCOPES = ["operator.approvals", "operator.chat", "operator.notifications"];
const buildClaimSignaturePayload = (p: { code: string; deviceId: string; signedAtMs: number }) =>
  ["bitterbot-mobile-pair", "v1", p.code, p.deviceId, String(p.signedAtMs)].join("|");

installGatewayTestHooks({ scope: "suite" });

/** A phone as the PWA builds it: a P-256 WebCrypto key (Safari before 17). */
function phoneKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  return {
    id: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKey: raw.toString("base64url"),
    sign: (payload: string) =>
      crypto
        .sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" })
        .toString("base64url"),
  };
}

/** A socket that looks like it came from a phone on the LAN, with its challenge nonce. */
async function openRemote(port: number): Promise<{ ws: WebSocket; nonce: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { "x-forwarded-for": "192.168.1.77", origin: `http://127.0.0.1:${port}` },
  });
  const nonce = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no challenge")), 10_000);
    ws.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        event?: string;
        payload?: { nonce?: string };
      };
      if (frame.event === "connect.challenge" && frame.payload?.nonce) {
        clearTimeout(timer);
        resolve(frame.payload.nonce);
      }
    });
    ws.once("error", reject);
  });
  return { ws, nonce };
}

function phoneConnect(
  ws: WebSocket,
  key: ReturnType<typeof phoneKey>,
  nonce: string,
  deviceToken: string | undefined,
  scopes: string[] = [...MOBILE_DEVICE_SCOPES],
) {
  const client = { id: MOBILE_CLIENT_ID, version: "test", platform: "ios-web", mode: "ui" };
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: key.id,
    clientId: client.id,
    clientMode: client.mode,
    role: "operator",
    scopes,
    signedAtMs: signedAt,
    token: null,
    nonce,
  });
  return connectReq(ws, {
    skipDefaultAuth: true,
    deviceToken,
    client,
    scopes,
    device: { id: key.id, publicKey: key.publicKey, signature: key.sign(payload), signedAt, nonce },
  });
}

async function post(port: number, pathName: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function pairPhone() {
  const started = await startServerWithClient("secret");
  const { server, ws: admin, port, prevToken } = started;
  cleanups.push(async () => {
    admin.close();
    await server.close();
    if (prevToken === undefined) delete process.env.BITTERBOT_GATEWAY_TOKEN;
    else process.env.BITTERBOT_GATEWAY_TOKEN = prevToken;
  });
  expect((await connectReq(admin, { token: "secret" })).ok).toBe(true);

  const created = await rpcReq<{ code: string; setupId: string }>(admin, "mobile.pair.create", {});
  expect(created.ok).toBe(true);
  const code = created.payload?.code ?? "";
  // The setup code is not the gateway token, and no URL carries the token.
  expect(code).not.toContain("secret");

  const key = phoneKey();
  const signedAt = Date.now();
  const claim = await post(port, "/m/api/pair/claim", {
    code,
    device: {
      id: key.id,
      publicKey: key.publicKey,
      signedAt,
      signature: key.sign(
        buildClaimSignaturePayload({ code, deviceId: key.id, signedAtMs: signedAt }),
      ),
    },
    displayName: "Test iPhone",
  });
  expect(claim.status).toBe(200);

  const list = await rpcReq<{
    pending: Array<{ requestId: string; setupId?: string; confirmCode?: string }>;
  }>(admin, "device.pair.list", {});
  const pending = list.payload?.pending.find((p) => p.setupId === created.payload?.setupId);
  expect(pending?.confirmCode).toBe(claim.json.confirmCode);

  // Before approval: the claim is pending and the phone cannot connect.
  const before = await post(port, "/m/api/pair/status", {
    claimId: claim.json.claimId,
    deviceId: key.id,
  });
  expect(before.json.status).toBe("pending");

  expect((await rpcReq(admin, "device.pair.approve", { requestId: pending?.requestId })).ok).toBe(
    true,
  );
  const after = await post(port, "/m/api/pair/status", {
    claimId: claim.json.claimId,
    deviceId: key.id,
  });
  expect(after.json.status).toBe("approved");
  return { admin, port, key, deviceToken: String(after.json.deviceToken) };
}

describe("phone pairing over the gateway (PLAN-62)", () => {
  test("a paired phone connects from a non-loopback address with its scoped device token", async () => {
    const { port, key, deviceToken } = await pairPhone();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    const res = await phoneConnect(ws, key, nonce, deviceToken);
    expect(res.ok).toBe(true);

    const self = await rpcReq<{ device: { deviceId: string; scopes: string[] } }>(
      ws,
      "mobile.self.get",
      {},
    );
    expect(self.ok).toBe(true);
    expect(self.payload?.device.deviceId).toBe(key.id);

    // Scoped: no admin, no pairing, no exec.
    for (const method of ["config.get", "device.pair.list", "exec.approvals.get", "node.invoke"]) {
      const denied = await rpcReq(ws, method, {});
      expect(denied.ok, method).toBe(false);
    }
  });

  test("a phone cannot widen its own scopes", async () => {
    const { port, key, deviceToken } = await pairPhone();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    const res = await phoneConnect(ws, key, nonce, deviceToken, ["operator.admin"]);
    expect(res.ok).toBe(false);
  });

  test("an unpaired phone with no token is refused, and creates no pairing request", async () => {
    const { admin, port } = await pairPhone();
    const stranger = phoneKey();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    const res = await phoneConnect(ws, stranger, nonce, undefined);
    expect(res.ok).toBe(false);
    const list = await rpcReq<{ pending: unknown[] }>(admin, "device.pair.list", {});
    expect(list.payload?.pending).toHaveLength(0);
  });

  test("removing the phone closes its open socket and its token stops working", async () => {
    const { admin, port, key, deviceToken } = await pairPhone();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    expect((await phoneConnect(ws, key, nonce, deviceToken)).ok).toBe(true);

    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    expect((await rpcReq(admin, "device.remove", { deviceId: key.id })).ok).toBe(true);
    expect(await closed).toBe(4001);

    const again = await openRemote(port);
    cleanups.push(() => again.ws.close());
    expect((await phoneConnect(again.ws, key, again.nonce, deviceToken)).ok).toBe(false);
  });

  test("revoking the token also disconnects the phone", async () => {
    const { admin, port, key, deviceToken } = await pairPhone();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    expect((await phoneConnect(ws, key, nonce, deviceToken)).ok).toBe(true);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    expect(
      (await rpcReq(admin, "device.token.revoke", { deviceId: key.id, role: "operator" })).ok,
    ).toBe(true);
    expect(await closed).toBe(4001);
  });

  test("a phone can unpair itself", async () => {
    const { admin, port, key, deviceToken } = await pairPhone();
    const { ws, nonce } = await openRemote(port);
    cleanups.push(() => ws.close());
    expect((await phoneConnect(ws, key, nonce, deviceToken)).ok).toBe(true);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    expect((await rpcReq(ws, "mobile.self.unpair", {})).ok).toBe(true);
    expect(await closed).toBe(4001);
    const list = await rpcReq<{ paired: Array<{ deviceId: string }> }>(
      admin,
      "device.pair.list",
      {},
    );
    expect(list.payload?.paired.some((d) => d.deviceId === key.id)).toBe(false);
  });
});
