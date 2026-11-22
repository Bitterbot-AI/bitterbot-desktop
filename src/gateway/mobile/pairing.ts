/**
 * PLAN-62: pairing a phone without the gateway token.
 *
 * The owner asks for a setup code (Control UI "Pair a phone", the `/pair` chat
 * command, or `bitterbot devices pair`). The code is a one-time, 128-bit secret
 * that lives five minutes, in memory only. The phone opens a link carrying it in
 * the URL fragment (never sent to the server as part of the URL, so it stays out
 * of access logs and Referer headers), generates its own device key, and claims
 * the code with a signature over the code from that key.
 *
 * A claim does not pair anything by itself. It files an ordinary device pairing
 * request, scoped to MOBILE_DEVICE_SCOPES, and both sides show the same short
 * confirmation code, derived from the setup secret and the phone's public key.
 * The owner approves only when the codes match, so a code that leaked to someone
 * else (a shoulder-surfed QR, a phished link) produces a request whose numbers do
 * not match the owner's phone. After approval the phone collects a per-device
 * token, which is useless without the private key that never leaves the phone.
 *
 * Nothing here ever handles the gateway token or password.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
  verifyDeviceSignature,
} from "../../infra/device-identity.js";
import {
  getPairedDevice,
  listDevicePairing,
  rejectDevicePairing,
  requestDevicePairing,
  type DevicePairingPendingRequest,
} from "../../infra/device-pairing.js";
import { MOBILE_CLIENT_ID, MOBILE_DEVICE_SCOPES } from "./scopes.js";

export const SETUP_CODE_TTL_MS = 5 * 60_000;
/** How long an approved phone has to collect its token. */
const CLAIM_COLLECT_TTL_MS = 10 * 60_000;
/** After the first collection, the same claimant may collect again for this long (a lost response). */
const CLAIM_RECOLLECT_GRACE_MS = 2 * 60_000;
const CLAIM_SIGNATURE_SKEW_MS = 10 * 60_000;
const MAX_OUTSTANDING_CODES = 8;

type SetupCodeEntry = {
  setupId: string;
  hash: Buffer;
  createdAtMs: number;
  expiresAtMs: number;
  createdBy?: string;
  /** Set once a device claims it; a code is single-use. */
  claimedBy?: { deviceId: string; claimId: string; signedAt: number; ready: boolean };
};

type ClaimEntry = {
  claimId: string;
  setupId: string;
  deviceId: string;
  requestId: string;
  createdAtMs: number;
  expiresAtMs: number;
  collectedAtMs?: number;
};

/**
 * Process-wide state. Plugins import this module through the plugin SDK,
 * which in a bundled install is a separate copy of the code: a module-level
 * Map would give the `/pair` command a table the gateway never reads. One
 * table per process, keyed on a registered symbol, keeps them the same.
 */
type PairingTables = { codes: Map<string, SetupCodeEntry>; claims: Map<string, ClaimEntry> };
const TABLES_KEY = Symbol.for("bitterbot.mobile.pairing.v1");
const globalTables = globalThis as unknown as Record<symbol, PairingTables | undefined>;
const tables: PairingTables = (globalTables[TABLES_KEY] ??= {
  codes: new Map<string, SetupCodeEntry>(),
  claims: new Map<string, ClaimEntry>(),
});
const codes = tables.codes;
const claims = tables.claims;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function prune(now: number) {
  for (const [key, entry] of codes) {
    if (entry.expiresAtMs <= now && !entry.claimedBy) {
      codes.delete(key);
    } else if (entry.claimedBy && now - entry.createdAtMs > CLAIM_COLLECT_TTL_MS) {
      codes.delete(key);
    }
  }
  for (const [key, claim] of claims) {
    if (claim.expiresAtMs <= now) {
      claims.delete(key);
    }
  }
}

/** Test hook: forget every code and claim. */
export function resetMobilePairingForTests() {
  codes.clear();
  claims.clear();
}

/** The payload the phone signs to claim a code with its key. */
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

/**
 * The six-digit code both screens show. Derived, not stored: the phone computes
 * it from the code it scanned and its own public key, the gateway from the code
 * and the key it received. A substituted key gives a different number.
 */
export function deriveConfirmCode(code: string, publicKeyBase64Url: string): string {
  const digest = sha256(`bitterbot-mobile-confirm|v1|${code}|${publicKeyBase64Url}`);
  const value = digest.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}

export type CreatedSetupCode = {
  code: string;
  setupId: string;
  expiresAtMs: number;
};

/** Mint a one-time setup code. The caller decides who may (an owner surface). */
export function createSetupCode(
  params: { createdBy?: string; now?: number } = {},
): CreatedSetupCode {
  const now = params.now ?? Date.now();
  prune(now);
  // Bound the table: an owner surface that loops cannot grow it without limit.
  const unclaimed = [...codes.values()]
    .filter((entry) => !entry.claimedBy)
    .toSorted((a, b) => a.createdAtMs - b.createdAtMs);
  while (unclaimed.length >= MAX_OUTSTANDING_CODES) {
    const oldest = unclaimed.shift();
    if (oldest) {
      codes.delete(oldest.hash.toString("hex"));
    }
  }
  const code = randomBytes(16).toString("base64url");
  const hash = sha256(code);
  const setupId = hash.subarray(0, 6).toString("hex");
  const entry: SetupCodeEntry = {
    setupId,
    hash,
    createdAtMs: now,
    expiresAtMs: now + SETUP_CODE_TTL_MS,
    createdBy: params.createdBy,
  };
  codes.set(hash.toString("hex"), entry);
  return { code, setupId, expiresAtMs: entry.expiresAtMs };
}

/** Cancel an unclaimed code early (the owner closed the dialog). */
export function cancelSetupCode(setupId: string): boolean {
  for (const [key, entry] of codes) {
    if (entry.setupId === setupId && !entry.claimedBy) {
      codes.delete(key);
      return true;
    }
  }
  return false;
}

function lookupCode(code: string): SetupCodeEntry | null {
  if (typeof code !== "string" || code.length < 16 || code.length > 64) {
    return null;
  }
  const hash = sha256(code);
  const entry = codes.get(hash.toString("hex"));
  if (!entry || !timingSafeEqual(entry.hash, hash)) {
    return null;
  }
  return entry;
}

export type ClaimInput = {
  code: string;
  device: { id: string; publicKey: string; signature: string; signedAt: number };
  displayName?: string;
  platform?: string;
  remoteIp?: string;
};

export type ClaimResult =
  | {
      ok: true;
      claimId: string;
      confirmCode: string;
      request: DevicePairingPendingRequest;
      created: boolean;
    }
  | { ok: false; status: number; error: string };

const GENERIC_CODE_ERROR = "This pairing code has expired or was already used. Make a new one.";

function cleanLabel(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // Display text only: strip control characters and bound the length.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

export async function claimSetupCode(input: ClaimInput, now = Date.now()): Promise<ClaimResult> {
  prune(now);
  const entry = lookupCode(input.code);
  if (!entry || (entry.expiresAtMs <= now && !entry.claimedBy)) {
    return { ok: false, status: 410, error: GENERIC_CODE_ERROR };
  }
  const device = input.device;
  if (
    !device ||
    typeof device.id !== "string" ||
    typeof device.publicKey !== "string" ||
    typeof device.signature !== "string" ||
    typeof device.signedAt !== "number"
  ) {
    return { ok: false, status: 400, error: "device identity required" };
  }
  const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
  if (!derivedId || derivedId !== device.id) {
    return { ok: false, status: 400, error: "device identity mismatch" };
  }
  if (Math.abs(now - device.signedAt) > CLAIM_SIGNATURE_SKEW_MS) {
    return { ok: false, status: 400, error: "device signature expired (check the phone's clock)" };
  }
  const payload = buildClaimSignaturePayload({
    code: input.code,
    deviceId: device.id,
    signedAtMs: device.signedAt,
  });
  if (!verifyDeviceSignature(device.publicKey, payload, device.signature)) {
    return { ok: false, status: 400, error: "device signature invalid" };
  }
  const publicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
  if (!publicKey) {
    return { ok: false, status: 400, error: "device public key invalid" };
  }

  // Single use. The same phone retrying (a dropped response) gets its claim
  // back, but only with a fresh signature (a newer signedAt), so a captured
  // claim request cannot be replayed to learn the claim id. Any other device
  // is refused, even inside the five minutes.
  if (entry.claimedBy) {
    const prior = entry.claimedBy;
    if (prior.deviceId !== device.id || !prior.ready || device.signedAt <= prior.signedAt) {
      return { ok: false, status: 410, error: GENERIC_CODE_ERROR };
    }
    const existing = claims.get(prior.claimId);
    if (existing && !existing.collectedAtMs) {
      const list = await listDevicePairing();
      const request = list.pending.find((p) => p.requestId === existing.requestId);
      if (request) {
        prior.signedAt = device.signedAt;
        return {
          ok: true,
          claimId: existing.claimId,
          confirmCode: deriveConfirmCode(input.code, publicKey),
          request,
          created: false,
        };
      }
    }
    return { ok: false, status: 410, error: GENERIC_CODE_ERROR };
  }

  // Reserve the code synchronously, before the first await: two concurrent
  // claims of one code cannot both get past this line.
  const claimId = randomBytes(18).toString("base64url");
  entry.claimedBy = { deviceId: device.id, claimId, signedAt: device.signedAt, ready: false };
  let pairing: Awaited<ReturnType<typeof requestDevicePairing>>;
  const confirmCode = deriveConfirmCode(input.code, publicKey);
  try {
    // A pending request from an earlier attempt of this device would be handed
    // back unchanged (with the old code's confirmation number): drop it first.
    const list = await listDevicePairing();
    for (const pending of list.pending) {
      if (pending.deviceId === device.id && pending.setupId !== entry.setupId) {
        await rejectDevicePairing(pending.requestId);
      }
    }
    pairing = await requestDevicePairing({
      deviceId: device.id,
      publicKey,
      displayName: cleanLabel(input.displayName, 64) ?? "Phone",
      platform: cleanLabel(input.platform, 32),
      clientId: MOBILE_CLIENT_ID,
      clientMode: "ui",
      role: "operator",
      scopes: [...MOBILE_DEVICE_SCOPES],
      remoteIp: input.remoteIp,
      silent: false,
      setupId: entry.setupId,
      confirmCode,
      principal: "phone",
    });
  } catch (err) {
    // Roll the reservation back so the owner's code is not burned by an I/O error.
    if (entry.claimedBy?.claimId === claimId) {
      entry.claimedBy = undefined;
    }
    throw err;
  }
  claims.set(claimId, {
    claimId,
    setupId: entry.setupId,
    deviceId: device.id,
    requestId: pairing.request.requestId,
    createdAtMs: now,
    expiresAtMs: now + CLAIM_COLLECT_TTL_MS,
  });
  entry.claimedBy.ready = true;
  return { ok: true, claimId, confirmCode, request: pairing.request, created: pairing.created };
}

export type ClaimStatus =
  | { status: "pending"; confirmCode?: string }
  | { status: "approved"; deviceToken: string; scopes: string[]; deviceId: string }
  | { status: "rejected" }
  | { status: "expired" };

/**
 * Where a claim stands. The token is released only for the device that filed
 * the claim (the caller proves the device id by holding the unguessable claim
 * id), and only once its pairing was approved with the mobile scopes.
 */
export async function readClaimStatus(params: {
  claimId: string;
  deviceId: string;
  now?: number;
}): Promise<ClaimStatus> {
  const now = params.now ?? Date.now();
  prune(now);
  const claim = typeof params.claimId === "string" ? claims.get(params.claimId) : undefined;
  if (!claim || claim.deviceId !== params.deviceId) {
    return { status: "expired" };
  }
  const list = await listDevicePairing();
  const pending = list.pending.find((p) => p.requestId === claim.requestId);
  if (pending) {
    return { status: "pending", confirmCode: pending.confirmCode };
  }
  const paired = await getPairedDevice(claim.deviceId);
  const token = paired?.tokens?.operator;
  if (paired && token && !token.revokedAtMs && paired.approvedAtMs >= claim.createdAtMs) {
    // The first collection starts a short grace window instead of consuming the
    // claim, so a phone whose response was lost (network drop, app killed) can
    // ask again. Only the claimant can (unguessable claim id + its device id).
    if (claim.collectedAtMs === undefined) {
      claim.collectedAtMs = now;
      claim.expiresAtMs = Math.min(claim.expiresAtMs, now + CLAIM_RECOLLECT_GRACE_MS);
    }
    return {
      status: "approved",
      deviceToken: token.token,
      scopes: token.scopes,
      deviceId: paired.deviceId,
    };
  }
  // Gone from pending and not approved since the claim: rejected, or it expired.
  claims.delete(claim.claimId);
  return now - claim.createdAtMs > SETUP_CODE_TTL_MS
    ? { status: "expired" }
    : { status: "rejected" };
}
