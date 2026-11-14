import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  deviceKeyAlgorithm,
  normalizeDevicePublicKeyBase64Url,
  verifyDeviceSignature,
} from "./device-identity.js";

/** A browser-shaped P-256 key: raw uncompressed point, P1363 signatures (WebCrypto ECDSA). */
function p256Browser() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  const sign = (payload: string) =>
    crypto
      .sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
  return { raw, publicKey: raw.toString("base64url"), sign };
}

function ed25519Browser() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    publicKey: raw.toString("base64url"),
    sign: (payload: string) =>
      crypto.sign(null, Buffer.from(payload), privateKey).toString("base64url"),
  };
}

describe("device signatures from browsers (PLAN-62)", () => {
  it("verifies an ECDSA P-256 signature over a raw uncompressed key", () => {
    const key = p256Browser();
    const payload = "v2|device|bitterbot-mobile|ui|operator|operator.chat|123|tok|nonce";
    expect(verifyDeviceSignature(key.publicKey, payload, key.sign(payload))).toBe(true);
    expect(verifyDeviceSignature(key.publicKey, `${payload}x`, key.sign(payload))).toBe(false);
  });

  it("rejects a DER-encoded ECDSA signature (WebCrypto never produces one)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x as string, "base64url"),
      Buffer.from(jwk.y as string, "base64url"),
    ]);
    const der = crypto.sign("sha256", Buffer.from("x"), privateKey).toString("base64url");
    expect(verifyDeviceSignature(raw.toString("base64url"), "x", der)).toBe(false);
  });

  it("still verifies raw Ed25519 keys", () => {
    const key = ed25519Browser();
    expect(verifyDeviceSignature(key.publicKey, "hello", key.sign("hello"))).toBe(true);
  });

  it("does not accept a signature from one scheme for a key of the other", () => {
    const ed = ed25519Browser();
    const p = p256Browser();
    expect(verifyDeviceSignature(p.publicKey, "hello", ed.sign("hello"))).toBe(false);
    expect(verifyDeviceSignature(ed.publicKey, "hello", p.sign("hello"))).toBe(false);
  });

  it("classifies keys by length and form, refusing anything else", () => {
    expect(deviceKeyAlgorithm(Buffer.alloc(32))).toBe("ed25519");
    const point = Buffer.alloc(65);
    point[0] = 0x04;
    expect(deviceKeyAlgorithm(point)).toBe("p256");
    expect(deviceKeyAlgorithm(Buffer.alloc(33))).toBeNull();
    expect(verifyDeviceSignature(Buffer.alloc(40).toString("base64url"), "x", "AAAA")).toBe(false);
  });

  it("derives the same device id for a P-256 key as the browser does (sha256 of the raw key)", () => {
    const key = p256Browser();
    const expected = crypto.createHash("sha256").update(key.raw).digest("hex");
    expect(deriveDeviceIdFromPublicKey(key.publicKey)).toBe(expected);
    expect(normalizeDevicePublicKeyBase64Url(key.publicKey)).toBe(key.publicKey);
  });
});
