/**
 * Aubaine protocol envelope: signing, verification, and validation.
 * docs/protocol/aubaine-v1/SPEC.md §3.
 *
 * Every protocol message (intent / offer / quote / commit / settlement_receipt)
 * is a signed JSON envelope. The signature is Ed25519 over a domain-prefixed JCS
 * preimage (`aubaine/v1\n` + canonical-JSON of the envelope without `signature`),
 * so anyone can verify a message without Bitterbot code. Identity is the raw
 * Ed25519 public key (`ed25519:<hex>`) — portable across agent frameworks.
 *
 * This module reproduces the published conformance vectors
 * (docs/protocol/aubaine-v1/test-vectors); `envelope.test.ts` pins it.
 */
import crypto from "node:crypto";
import { canonicalJson, type JsonValue } from "./sku.js";

export const AUBAINE_PROTOCOL = "aubaine/v1";
export const MAX_ENVELOPE_BYTES = 262_144;
export const CLOCK_SKEW_SECONDS = 300;

export type EnvelopeType =
  | "intent"
  | "offer"
  | "quote_request"
  | "quote_response"
  | "commit_request"
  | "commit_response"
  | "settlement_receipt";

export interface Envelope {
  protocol: string;
  type: EnvelopeType;
  id: string;
  author_pubkey: string;
  ts: number;
  identity_proof?: Record<string, JsonValue>;
  body: Record<string, JsonValue>;
  signature?: string;
}

export interface KeyPair {
  privateKey: crypto.KeyObject;
  publicKeyHex: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawHexFromPublicKey(pub: crypto.KeyObject): string {
  const spki = pub.export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}

function publicKeyFromHex(hex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

/** Build the domain-prefixed JCS signing preimage (SPEC §3.1). */
export function signingPreimage(env: Envelope): Buffer {
  const { signature: _omit, ...unsigned } = env;
  return Buffer.from(`${AUBAINE_PROTOCOL}\n${canonicalJson(unsigned as JsonValue)}`, "utf8");
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKeyHex: rawHexFromPublicKey(publicKey) };
}

/** Adapt an existing Ed25519 identity (e.g. the device-identity PEM) to a KeyPair. */
export function keyPairFromPrivateKeyPem(pem: string): KeyPair {
  const privateKey = crypto.createPrivateKey(pem);
  return { privateKey, publicKeyHex: rawHexFromPublicKey(crypto.createPublicKey(privateKey)) };
}

/** The `ed25519:<hex>` identity string for a key pair. */
export function pubkeyId(key: KeyPair): string {
  return `ed25519:${key.publicKeyHex}`;
}

/** Sign an unsigned envelope, returning a copy with `signature` set. */
export function signEnvelope(env: Omit<Envelope, "signature">, key: KeyPair): Envelope {
  const full: Envelope = { ...env };
  full.signature = crypto.sign(null, signingPreimage(full), key.privateKey).toString("hex");
  return full;
}

/** Verify the Ed25519 signature against the envelope's `author_pubkey`. */
export function verifyEnvelope(env: Envelope): boolean {
  if (typeof env.signature !== "string") {
    return false;
  }
  const match = /^ed25519:([0-9a-f]{64})$/.exec(env.author_pubkey);
  if (!match || !/^[0-9a-f]{128}$/.test(env.signature)) {
    return false;
  }
  try {
    return crypto.verify(
      null,
      signingPreimage(env),
      publicKeyFromHex(match[1] as string),
      Buffer.from(env.signature, "hex"),
    );
  } catch {
    return false;
  }
}

export interface ValidateOptions {
  now?: number;
  maxSkewSeconds?: number;
  maxBytes?: number;
  expectedType?: EnvelopeType;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/** Full receiver-side validation (SPEC §3.3): protocol, type, size, ts window, signature. */
export function validateEnvelope(env: Envelope, opts: ValidateOptions = {}): ValidationResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.maxSkewSeconds ?? CLOCK_SKEW_SECONDS;
  const maxBytes = opts.maxBytes ?? MAX_ENVELOPE_BYTES;

  if (env.protocol !== AUBAINE_PROTOCOL) {
    return { ok: false, error: "unsupported protocol" };
  }
  if (opts.expectedType && env.type !== opts.expectedType) {
    return { ok: false, error: `expected type ${opts.expectedType}, got ${env.type}` };
  }
  if (typeof env.ts !== "number" || Math.abs(now - env.ts) > skew) {
    return { ok: false, error: "timestamp outside skew window" };
  }
  if (Buffer.byteLength(JSON.stringify(env), "utf8") > maxBytes) {
    return { ok: false, error: "envelope exceeds size limit" };
  }
  if (!verifyEnvelope(env)) {
    return { ok: false, error: "invalid signature" };
  }
  return { ok: true };
}

/** Construct + sign a fresh envelope of the given type. */
export function makeEnvelope(
  type: EnvelopeType,
  body: Record<string, JsonValue>,
  key: KeyPair,
  now: number = Math.floor(Date.now() / 1000),
): Envelope {
  return signEnvelope(
    {
      protocol: AUBAINE_PROTOCOL,
      type,
      id: crypto.randomUUID(),
      author_pubkey: pubkeyId(key),
      ts: now,
      body,
    },
    key,
  );
}
