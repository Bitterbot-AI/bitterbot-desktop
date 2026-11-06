import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  buildClaimSignaturePayload,
  buildDeviceAuthPayload,
  bytesToBase64Url,
  deriveConfirmCode,
  deviceIdForPublicKey,
} from "./device-identity";

// Vectors computed with the gateway's own functions (src/gateway/device-auth.ts,
// src/gateway/mobile/pairing.ts): browser and gateway must agree byte for byte.
describe("browser device identity (PLAN-62)", () => {
  it("builds the same v2 handshake payload as the gateway", () => {
    expect(
      buildDeviceAuthPayload({
        deviceId: "d",
        clientId: "bitterbot-mobile",
        clientMode: "ui",
        role: "operator",
        scopes: ["operator.approvals", "operator.chat"],
        signedAtMs: 7,
        token: null,
        nonce: "n",
      }),
    ).toBe("v2|d|bitterbot-mobile|ui|operator|operator.approvals,operator.chat|7||n");
  });

  it("falls back to v1 without a nonce", () => {
    expect(
      buildDeviceAuthPayload({
        deviceId: "d",
        clientId: "c",
        clientMode: "ui",
        role: "operator",
        scopes: [],
        signedAtMs: 1,
        token: "t",
      }),
    ).toBe("v1|d|c|ui|operator||1|t");
  });

  it("builds the same claim payload and confirmation code as the gateway", async () => {
    expect(buildClaimSignaturePayload({ code: "c", deviceId: "d", signedAtMs: 5 })).toBe(
      "bitterbot-mobile-pair|v1|c|d|5",
    );
    expect(await deriveConfirmCode("AAAAAAAAAAAAAAAAAAAAAA", "Zm9vYmFyLXB1YmxpYy1rZXk")).toBe(
      "695915",
    );
  });

  it("round-trips base64url and derives the device id as sha256 hex of the raw key", async () => {
    const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(raw))).toEqual(raw);
    expect(bytesToBase64Url(raw)).not.toMatch(/[+/=]/);
    expect(await deviceIdForPublicKey(new Uint8Array(32))).toBe(
      "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
    );
  });
});
