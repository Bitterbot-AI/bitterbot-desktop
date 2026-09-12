/**
 * PLAN-48 Phase 5 / D-1: AP2 SD-JWT + P-256 (ES256) wire format. The key
 * property Phase 1 lacked is cross-verifiability — a verifier holding ONLY the
 * P-256 JWK (no secp256k1 / eip155 knowledge) can verify a Bitterbot mandate.
 */
import { describe, expect, it } from "vitest";
import { usdc } from "./mandate.js";
import {
  decodeMandateSdJwt,
  emitPaymentMandateSdJwt,
  encodeMandateSdJwt,
  generateP256KeyPair,
  verifyMandateSdJwt,
  type P256Jwk,
} from "./sd-jwt.js";

function baseClaims(jwk: P256Jwk, over: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return {
    vct: "mandate.payment.1",
    iat,
    exp: iat + 300,
    cnf: { jwk },
    payee: { id: "0x00000000000000000000000000000000000000aa" },
    payment_amount: usdc(0.25),
    ...over,
  };
}

describe("AP2 SD-JWT / P-256 wire format", () => {
  it("round-trips: an ES256-signed mandate verifies against its cnf.jwk", () => {
    const { privateKey, publicJwk } = generateP256KeyPair();
    const token = encodeMandateSdJwt(baseClaims(publicJwk), privateKey);
    const res = verifyMandateSdJwt(token);
    expect(res.valid).toBe(true);
    const claims = res.claims!;
    expect((claims.payment_amount as { amount: string }).amount).toBe("0.25");
  });

  it("is a standard compact JWS with an ES256 header and an SD-JWT trailer", () => {
    const { privateKey, publicJwk } = generateP256KeyPair();
    const token = encodeMandateSdJwt(baseClaims(publicJwk), privateKey);
    expect(token.endsWith("~")).toBe(true); // SD-JWT (zero disclosures)
    const { header } = decodeMandateSdJwt(token);
    expect(header.alg).toBe("ES256");
    expect(token.split("~")[0]!.split(".")).toHaveLength(3);
  });

  it("cross-verifies with ONLY the P-256 JWK (no secp256k1 / eip155 needed)", () => {
    const { privateKey, publicJwk } = generateP256KeyPair();
    const token = emitPaymentMandateSdJwt({
      payee: { id: "0x00000000000000000000000000000000000000AA" },
      amount: usdc(0.5),
      instrument: { id: "0x1593", type: "x402-usdc" },
      transactionId: "0xabc",
      intentRef: "sha256:deadbeef",
      ttlSeconds: 300,
      privateKey,
      publicJwk,
    });
    // A third party who has only the JWK can decode + verify.
    const { claims } = decodeMandateSdJwt(token);
    expect((claims.cnf as { jwk: P256Jwk }).jwk).toEqual(publicJwk);
    expect(verifyMandateSdJwt(token).valid).toBe(true);
    expect((claims.payee as { id: string }).id).toBe(
      "0x00000000000000000000000000000000000000aa", // lowercased
    );
  });

  it("rejects a tampered payload (signature no longer covers the claims)", () => {
    const { privateKey, publicJwk } = generateP256KeyPair();
    const token = encodeMandateSdJwt(baseClaims(publicJwk), privateKey);
    const [h, p, rest] = token.split(".");
    // Re-encode a mutated payload (bump the amount) but keep the old signature.
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString("utf-8"));
    claims.payment_amount = usdc(999);
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const forged = `${h}.${forgedPayload}.${rest}`;
    expect(verifyMandateSdJwt(forged).valid).toBe(false);
  });

  it("rejects a mandate signed by a different key than its cnf.jwk (key substitution)", () => {
    const a = generateP256KeyPair();
    const b = generateP256KeyPair();
    // Claims declare key B's JWK, but we sign with key A.
    const token = encodeMandateSdJwt(baseClaims(b.publicJwk), a.privateKey);
    const res = verifyMandateSdJwt(token);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not verify/);
  });

  it("rejects an expired mandate", () => {
    const { privateKey, publicJwk } = generateP256KeyPair();
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = encodeMandateSdJwt(
      baseClaims(publicJwk, { iat: past - 300, exp: past }),
      privateKey,
    );
    const res = verifyMandateSdJwt(token);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/expired/);
  });

  it("rejects a mandate with no cnf.jwk", () => {
    const { privateKey } = generateP256KeyPair();
    const iat = Math.floor(Date.now() / 1000);
    const token = encodeMandateSdJwt({ vct: "mandate.payment.1", iat, exp: iat + 300 }, privateKey);
    expect(verifyMandateSdJwt(token).error).toMatch(/cnf\.jwk/);
  });

  it("rejects a non-ES256 alg and a malformed token", () => {
    expect(verifyMandateSdJwt("not.a.jwt").valid).toBe(false);
    expect(verifyMandateSdJwt("only-one-segment").valid).toBe(false);
  });
});
