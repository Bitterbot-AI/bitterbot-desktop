/**
 * Browser device identity (PLAN-62).
 *
 * The gateway binds every scoped token to a device key: a connection proves it
 * holds the key by signing the handshake (including the server's one-time
 * nonce), so a copied token alone is worthless. This module gives the browser
 * clients that key.
 *
 * Algorithm, in order of preference:
 *   1. WebCrypto Ed25519, non-extractable. What the gateway's own node host
 *      uses. Safari 17+, Chrome/Edge 137+, Firefox 129+.
 *   2. WebCrypto ECDSA P-256, non-extractable, for older browsers (iOS 16.4
 *      Safari, older Android Chrome). The gateway verifies both (a raw P-256
 *      key is a 65-byte point, an Ed25519 key 32 bytes, so they never collide).
 *   3. Only where the caller allows it: pure-JS Ed25519 for pages served over
 *      plain HTTP on a LAN address, where browsers withhold `crypto.subtle`
 *      entirely. That key is extractable in principle (it lives in IndexedDB as
 *      bytes), which the phone app tells the owner about.
 *
 * Keys live in IndexedDB under a name, so the Control UI and the phone app on
 * the same browser are two distinct devices with distinct scopes.
 */

export type DeviceKeyAlgorithm = "Ed25519" | "P-256" | "Ed25519-js";

export type BrowserDeviceIdentity = {
  /** sha256(raw public key), hex: what the gateway derives and checks. */
  deviceId: string;
  /** Raw public key, base64url. */
  publicKey: string;
  algorithm: DeviceKeyAlgorithm;
  /** Signs UTF-8 text; returns a base64url signature. */
  sign: (payload: string) => Promise<string>;
};

type StoredKey =
  | {
      algorithm: "Ed25519" | "P-256";
      privateKey: CryptoKey;
      publicKey: string;
      createdAtMs: number;
    }
  | {
      algorithm: "Ed25519-js";
      privateKeyBytes: Uint8Array;
      publicKey: string;
      createdAtMs: number;
    };

const DB_NAME = "bitterbot-device";
const STORE = "keys";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function subtle(): SubtleCrypto | null {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  return c && c.subtle && (typeof isSecureContext === "undefined" || isSecureContext)
    ? c.subtle
    : null;
}

/** SHA-256, with a pure-JS fallback where `crypto.subtle` is withheld. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    return new Uint8Array(await s.digest("SHA-256", bytes as BufferSource));
  }
  const { sha256: jsSha256 } = await import("@noble/hashes/sha2");
  return jsSha256(bytes);
}

export async function deviceIdForPublicKey(rawPublicKey: Uint8Array): Promise<string> {
  return toHex(await sha256(rawPublicKey));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.addEventListener("upgradeneeded", () => {
      req.result.createObjectStore(STORE);
    });
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error ?? new Error("indexedDB open failed")));
  });
}

async function idbGet(name: string): Promise<StoredKey | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(name);
      req.addEventListener("success", () => resolve(req.result as StoredKey | undefined));
      req.addEventListener("error", () => reject(req.error ?? new Error("indexedDB read failed")));
    });
  } finally {
    db.close();
  }
}

async function idbPut(name: string, value: StoredKey | null): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      if (value) {
        tx.objectStore(STORE).put(value, name);
      } else {
        tx.objectStore(STORE).delete(name);
      }
      tx.addEventListener("complete", () => resolve());
      tx.addEventListener("error", () => reject(tx.error ?? new Error("indexedDB write failed")));
    });
  } finally {
    db.close();
  }
}

async function generateWebCryptoKey(s: SubtleCrypto): Promise<StoredKey | null> {
  // Ed25519 first: smaller, and what every other Bitterbot device uses.
  try {
    const pair = (await s.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await s.exportKey("raw", pair.publicKey));
    // Prove the key signs before keeping it (some engines advertise and then refuse).
    await s.sign({ name: "Ed25519" }, pair.privateKey, new Uint8Array([1]));
    return {
      algorithm: "Ed25519",
      privateKey: pair.privateKey,
      publicKey: bytesToBase64Url(raw),
      createdAtMs: Date.now(),
    };
  } catch {
    // fall through to P-256
  }
  try {
    const pair = (await s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await s.exportKey("raw", pair.publicKey));
    return {
      algorithm: "P-256",
      privateKey: pair.privateKey,
      publicKey: bytesToBase64Url(raw),
      createdAtMs: Date.now(),
    };
  } catch {
    return null;
  }
}

async function generateJsKey(): Promise<StoredKey> {
  const { ed25519 } = await import("@noble/curves/ed25519");
  const privateKeyBytes = ed25519.utils.randomPrivateKey();
  return {
    algorithm: "Ed25519-js",
    privateKeyBytes,
    publicKey: bytesToBase64Url(ed25519.getPublicKey(privateKeyBytes)),
    createdAtMs: Date.now(),
  };
}

function signerFor(stored: StoredKey): (payload: string) => Promise<string> {
  const encoder = new TextEncoder();
  if (stored.algorithm === "Ed25519-js") {
    return async (payload) => {
      const { ed25519 } = await import("@noble/curves/ed25519");
      return bytesToBase64Url(ed25519.sign(encoder.encode(payload), stored.privateKeyBytes));
    };
  }
  return async (payload) => {
    const s = subtle();
    if (!s) {
      throw new Error("WebCrypto unavailable");
    }
    const params: AlgorithmIdentifier | EcdsaParams =
      stored.algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" };
    const sig = await s.sign(params, stored.privateKey, encoder.encode(payload));
    return bytesToBase64Url(new Uint8Array(sig));
  };
}

const cache = new Map<string, Promise<BrowserDeviceIdentity | null>>();

/**
 * Load this browser's key for `name`, creating it on first use. Null when no
 * usable key can exist here (no IndexedDB, or an insecure context the caller
 * did not opt into).
 */
export function loadOrCreateDeviceIdentity(
  name: string,
  opts: { allowInsecureFallback?: boolean } = {},
): Promise<BrowserDeviceIdentity | null> {
  const key = `${name}|${opts.allowInsecureFallback ? 1 : 0}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = loadOrCreate(name, opts).catch((err: unknown) => {
      console.warn("[device-identity] unavailable:", err);
      cache.delete(key);
      return null;
    });
    cache.set(key, pending);
  }
  return pending;
}

async function loadOrCreate(
  name: string,
  opts: { allowInsecureFallback?: boolean },
): Promise<BrowserDeviceIdentity | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  const s = subtle();
  let stored: StoredKey | undefined = await idbGet(name);
  // A WebCrypto key cannot be used where crypto.subtle is gone. Never replace
  // it (that would silently re-key a paired device): report no identity.
  if (stored && stored.algorithm !== "Ed25519-js" && !s) {
    return null;
  }
  if (stored && stored.algorithm === "Ed25519-js" && !opts.allowInsecureFallback) {
    return null;
  }
  if (!stored) {
    const created = s ? await generateWebCryptoKey(s) : null;
    if (created) {
      stored = created;
    } else if (opts.allowInsecureFallback) {
      stored = await generateJsKey();
    } else {
      return null;
    }
    await idbPut(name, stored);
  }
  const raw = base64UrlToBytes(stored.publicKey);
  return {
    deviceId: await deviceIdForPublicKey(raw),
    publicKey: stored.publicKey,
    algorithm: stored.algorithm,
    sign: signerFor(stored),
  };
}

/** Forget the key (unpair). The next load makes a new device. */
export async function clearDeviceIdentity(name: string): Promise<void> {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(`${name}|`)) {
      cache.delete(key);
    }
  }
  if (typeof indexedDB !== "undefined") {
    await idbPut(name, null);
  }
}

/** The handshake payload the gateway verifies (src/gateway/device-auth.ts, v2). */
export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
}): string {
  const version = params.nonce ? "v2" : "v1";
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
  ];
  if (version === "v2") {
    base.push(params.nonce ?? "");
  }
  return base.join("|");
}

/** The payload a phone signs to claim a setup code (src/gateway/mobile/pairing.ts). */
export function buildClaimSignaturePayload(params: {
  code: string;
  deviceId: string;
  signedAtMs: number;
}): string {
  return [
    "bitterbot-mobile-pair",
    "v1",
    params.code,
    params.deviceId,
    String(params.signedAtMs),
  ].join("|");
}

/** The six-digit number both screens show while pairing (matches the gateway's). */
export async function deriveConfirmCode(code: string, publicKey: string): Promise<string> {
  const digest = await sha256(
    new TextEncoder().encode(`bitterbot-mobile-confirm|v1|${code}|${publicKey}`),
  );
  const value = ((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3];
  return String(value % 1_000_000).padStart(6, "0");
}
