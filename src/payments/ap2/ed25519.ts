/**
 * Ed25519 helpers for the payments layer (PLAN-47/48). One place for the
 * `ed25519:<hex>` <-> SPKI conversion and the node's Circles-identity signer, so
 * a2a-client, the payment gate, and the spend-grant RPCs don't each re-implement
 * it. The node's Circles/consent identity IS its device identity (device.json),
 * per src/circles/service.ts.
 */

import { createHash, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify an Ed25519 signature (hex) over `message` for an `ed25519:<64hex>` pubkey. Never throws. */
export function verifyEd25519(message: string, signatureHex: string, pubkey: string): boolean {
  try {
    const m = /^ed25519:([0-9a-f]{64})$/.exec(pubkey);
    if (!m || !/^[0-9a-f]+$/.test(signatureHex)) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(m[1]!, "hex")]),
      format: "der",
      type: "spki",
    });
    return nodeVerify(null, Buffer.from(message), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export interface NodeCircleSigner {
  /** The node's Circles identity in `ed25519:<hex>` form. */
  pubkey: string;
  /** Sign `message` with the node's Ed25519 device key, returning a hex signature. */
  signEd25519: (message: string) => string;
}

/**
 * Load the node's Circles/device Ed25519 identity as a signer. Used server-side
 * (spend-grant RPCs, outbound consent) to sign on behalf of the node's owner.
 */
export async function loadNodeCircleSigner(): Promise<NodeCircleSigner> {
  const { keyPairFromPrivateKeyPem, pubkeyId } = await import("../../commerce/envelope.js");
  const { loadOrCreateDeviceIdentity } = await import("../../infra/device-identity.js");
  const key = keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
  return {
    pubkey: pubkeyId(key),
    signEd25519: (message: string) =>
      nodeSign(null, Buffer.from(message), key.privateKey).toString("hex"),
  };
}

/** Short, stable id derived from a string (used for approval ids). */
export function shortId(prefix: string, seed: string): string {
  return prefix + ":" + createHash("sha256").update(seed).digest("hex").slice(0, 24);
}
