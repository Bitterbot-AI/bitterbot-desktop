/**
 * PLAN-31 C1 transport: sealed-box crypto for the relay mailbox (§3.2).
 *
 * Every node holds an X25519 "box" keypair alongside its Ed25519 identity
 * (identity/box.json). The box PUBLIC key travels only inside Ed25519-signed
 * circle envelopes (join/presence bodies), so a peer's box key is
 * authenticated by the same signature chain as everything else.
 *
 * Sealing (standard sealed-box construction, Node built-ins only):
 *   ephemeral X25519 keypair -> ECDH(ephemeral, recipient) -> HKDF-SHA256
 *   (salt = ephemeral pub || recipient pub, info = domain string) ->
 *   AES-256-GCM. The blob carries {v, epk, iv, ct, tag}; only the recipient's
 *   box PRIVATE key opens it. A mailbox host stores ciphertext it cannot
 *   read, which is the §3.2 honesty claim: "no server that can read your
 *   messages or own your graph."
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const HKDF_INFO = "circle-mailbox/v1 sealed box";

export type BoxKeyPair = {
  publicKeyB64: string;
  privateKey: crypto.KeyObject;
};

export type SealedBlob = {
  v: 1;
  /** Ephemeral X25519 public key (base64, SPKI raw 32 bytes). */
  epk: string;
  iv: string;
  ct: string;
  tag: string;
};

const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function rawFromPublicKey(pub: crypto.KeyObject): Buffer {
  const spki = pub.export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function publicKeyFromRawB64(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error("box pubkey must be 32 raw bytes");
  }
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function generateBoxKeyPair(): BoxKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return { publicKeyB64: rawFromPublicKey(publicKey).toString("base64"), privateKey };
}

type StoredBoxKeys = {
  version: 1;
  publicKeyB64: string;
  privateKeyPem: string;
  createdAtMs: number;
};

function defaultBoxKeyPath(): string {
  return path.join(resolveStateDir(), "identity", "box.json");
}

/** Load (or create + persist, 0600) the node's box keypair. */
export function loadOrCreateBoxKeys(filePath: string = defaultBoxKeyPath()): BoxKeyPair {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoredBoxKeys;
      if (
        parsed?.version === 1 &&
        typeof parsed.publicKeyB64 === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        return {
          publicKeyB64: parsed.publicKeyB64,
          privateKey: crypto.createPrivateKey(parsed.privateKeyPem),
        };
      }
    }
  } catch {
    // fall through to regenerate
  }
  const pair = generateBoxKeyPair();
  const stored: StoredBoxKeys = {
    version: 1,
    publicKeyB64: pair.publicKeyB64,
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAtMs: Date.now(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
  return pair;
}

function deriveKey(shared: Buffer, epkRaw: Buffer, recipientRaw: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.concat([epkRaw, recipientRaw]), HKDF_INFO, 32),
  );
}

/** Seal plaintext to a recipient's box pubkey. */
export function sealToBox(recipientPubB64: string, plaintext: string): SealedBlob {
  const recipientPub = publicKeyFromRawB64(recipientPubB64);
  const eph = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipientPub });
  const epkRaw = rawFromPublicKey(eph.publicKey);
  const key = deriveKey(shared, epkRaw, Buffer.from(recipientPubB64, "base64"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    epk: epkRaw.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Open a sealed blob with our box private key. Returns null on any failure. */
export function openBox(ours: BoxKeyPair, blob: SealedBlob): string | null {
  try {
    if (blob?.v !== 1) return null;
    // Pin the GCM parameters: a 96-bit IV and a full 128-bit tag. Without the
    // length checks, Node's setAuthTag accepts a 4-byte tag and validates it,
    // downgrading forgery resistance to 2^32 (security pass M1).
    const iv = Buffer.from(blob.iv, "base64");
    const tag = Buffer.from(blob.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const epk = publicKeyFromRawB64(blob.epk);
    const shared = crypto.diffieHellman({ privateKey: ours.privateKey, publicKey: epk });
    const key = deriveKey(
      shared,
      Buffer.from(blob.epk, "base64"),
      Buffer.from(ours.publicKeyB64, "base64"),
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(blob.ct, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}
