/**
 * AP2 SD-JWT / P-256 (ES256) wire format — PLAN-48 Phase 5 / PLAN-47 D-1.
 *
 * The mandate layer (src/payments/ap2/mandate.ts) is AP2-*modeled*: it uses the
 * verbatim AP2 claim vocabulary but signs the canonical JSON with the agent's
 * production secp256k1 / EIP-191 key and expresses the key as an eip155 address
 * in `cnf`. That is self-verifiable but NOT cross-verifiable by a third-party AP2
 * verifier, which expects AP2's canonical encoding: an **SD-JWT signed with a
 * P-256 (ES256) key, with the signing key expressed as a JWK in `cnf`**.
 *
 * This module is that wire format, isolated exactly as the D-1 note promised
 * (canonical encoding + sign/recover + the `cnf` shape) so it can be swapped in
 * for third-party interop without touching the rest of the codebase. It emits a
 * standard compact JWS (`base64url(header).base64url(payload).base64url(sig)`)
 * with `alg: ES256`, an ECDSA-P256 signature in the JWS raw (IEEE P1363 r‖s)
 * encoding, and the P-256 public key as a JWK in the payload's `cnf.jwk`. Any
 * conformant ES256 verifier can check it against that JWK — the cross-verifiable
 * property Phase 1 lacked.
 *
 * We implement the issuer-signed JWT portion of SD-JWT (no selective-disclosure
 * digests yet — AP2 payment mandates disclose all claims to the settling party,
 * so `~`-separated disclosures are omitted; the format is a strict SD-JWT with
 * zero disclosures, still parseable by an SD-JWT verifier).
 */

import {
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { AP2_VCT, type MandateAmount } from "./mandate.js";

/** A P-256 public key as a JWK (the `cnf.jwk` shape AP2 uses). */
export interface P256Jwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** ES256 JWS header. */
interface JwsHeader {
  alg: "ES256";
  typ: string;
}

const JWS_TYP = "vc+sd-jwt";

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Generate a P-256 keypair and its public JWK (for `cnf.jwk`). */
export function generateP256KeyPair(): { privateKey: KeyObject; publicJwk: P256Jwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { crv?: string; x?: string; y?: string };
  if (jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("failed to export P-256 public JWK");
  }
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } };
}

function jwkToPublicKey(jwk: P256Jwk): KeyObject {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("cnf.jwk is not a P-256 EC public key");
  }
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
}

/**
 * Encode claims as an ES256-signed compact JWS. The caller is responsible for
 * having placed the signing key's public JWK at `cnf.jwk` in `claims` so the
 * token is self-verifiable (verifyMandateSdJwt checks the signature against it);
 * `assertCnfMatches` guards that invariant.
 */
export function encodeMandateSdJwt(claims: Record<string, unknown>, privateKey: KeyObject): string {
  const header: JwsHeader = { alg: "ES256", typ: JWS_TYP };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(
    Buffer.from(JSON.stringify(claims)),
  )}`;
  // ieee-p1363 = the raw r‖s encoding JWS requires (node defaults to DER for EC).
  const sig = nodeSign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  // Trailing `~` marks an SD-JWT with zero selective-disclosure elements.
  return `${signingInput}.${b64url(sig)}~`;
}

export interface DecodedSdJwt {
  header: JwsHeader;
  claims: Record<string, unknown>;
}

/** Decode (without verifying) the header + claims of a mandate SD-JWT. */
export function decodeMandateSdJwt(token: string): DecodedSdJwt {
  const jws = token.split("~")[0]!; // drop disclosures/trailer
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("malformed SD-JWT: expected 3 JWS segments");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf-8")) as JwsHeader;
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8")) as Record<
    string,
    unknown
  >;
  return { header, claims };
}

export interface SdJwtVerifyResult {
  valid: boolean;
  error?: string;
  claims?: Record<string, unknown>;
}

/**
 * Verify a mandate SD-JWT: ES256 signature over the JWS, checked against the
 * P-256 key declared in the payload's `cnf.jwk` (the self-verifiable property),
 * plus expiry (`exp`, unix seconds) when present. This is the AP2-native check a
 * third-party verifier runs — no secp256k1 / eip155 knowledge required.
 */
export function verifyMandateSdJwt(token: string, opts?: { now?: number }): SdJwtVerifyResult {
  let decoded: DecodedSdJwt;
  try {
    decoded = decodeMandateSdJwt(token);
  } catch (err) {
    return { valid: false, error: `decode failed: ${String(err)}` };
  }
  if (decoded.header.alg !== "ES256") {
    return { valid: false, error: `unsupported alg: ${String(decoded.header.alg)}` };
  }
  const cnf = decoded.claims.cnf as { jwk?: P256Jwk } | undefined;
  if (!cnf?.jwk) return { valid: false, error: "claims missing cnf.jwk" };

  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const exp = decoded.claims.exp;
  if (typeof exp === "number" && exp <= now) {
    return { valid: false, error: "mandate expired" };
  }

  const jws = token.split("~")[0]!;
  const parts = jws.split(".");
  const signingInput = `${parts[0]}.${parts[1]}`;
  let ok = false;
  try {
    ok = nodeVerify(
      "sha256",
      Buffer.from(signingInput),
      { key: jwkToPublicKey(cnf.jwk), dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2]!, "base64url"),
    );
  } catch (err) {
    return { valid: false, error: `signature verify failed: ${String(err)}` };
  }
  if (!ok) return { valid: false, error: "signature does not verify against cnf.jwk" };
  return { valid: true, claims: decoded.claims };
}

/**
 * Emit an AP2 Payment mandate in SD-JWT / ES256 form — the cross-verifiable
 * counterpart to `issuePaymentMandate` in mandate.ts. Same verbatim AP2 claim
 * vocabulary, but the P-256 wire format (`cnf.jwk`, ES256 JWS) a third-party AP2
 * verifier accepts. The signing key's public JWK is placed at `cnf.jwk`, so the
 * token verifies with `verifyMandateSdJwt` and any conformant ES256 verifier.
 */
export function emitPaymentMandateSdJwt(params: {
  payee: { id: string; name?: string; website?: string };
  amount: MandateAmount;
  instrument: { id: string; type: string; description?: string };
  transactionId: string;
  intentRef: string;
  ttlSeconds: number;
  consentRef?: string;
  privateKey: KeyObject;
  publicJwk: P256Jwk;
  now?: number;
}): string {
  const iat = params.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    vct: AP2_VCT.payment,
    transaction_id: params.transactionId,
    iat,
    exp: iat + params.ttlSeconds,
    cnf: { jwk: params.publicJwk },
    payee: { ...params.payee, id: params.payee.id.toLowerCase() },
    payment_amount: params.amount,
    payment_instrument: params.instrument,
    intent_ref: params.intentRef,
    ...(params.consentRef ? { consent_ref: params.consentRef } : {}),
  };
  return encodeMandateSdJwt(claims, params.privateKey);
}
