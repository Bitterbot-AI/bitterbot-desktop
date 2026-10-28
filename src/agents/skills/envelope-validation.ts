/**
 * Skill envelope authenticity checks shared by every storage boundary.
 *
 * The filesystem ingest (`ingest.ts`) and the crystal-level ingest
 * (`SkillNetworkBridge.ingestNetworkSkill`) both have to run these before
 * anything is written: a peer envelope whose bytes do not match its signature
 * or its content hash must never reach the skills directory or the chunk store.
 */

import { createHash, createPublicKey, verify } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SkillEnvelope } from "./ingest.js";

const log = createSubsystemLogger("skills/envelope-validation");

/** SPKI DER prefix for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Ed25519 verification of `skill_md` (decoded bytes) against the envelope's
 * raw 32-byte `author_pubkey` and 64-byte `signature`, both base64.
 */
export function verifySkillSignature(envelope: SkillEnvelope): boolean {
  try {
    const pubkeyBytes = Buffer.from(envelope.author_pubkey, "base64");
    const signatureBytes = Buffer.from(envelope.signature, "base64");
    if (pubkeyBytes.length !== 32 || signatureBytes.length !== 64) {
      return false;
    }
    const skillBytes = Buffer.from(envelope.skill_md, "base64");
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, pubkeyBytes]),
      format: "der",
      type: "spki",
    });
    return verify(null, skillBytes, publicKey, signatureBytes);
  } catch (err) {
    log.debug(`Signature verification error: ${String(err)}`);
    return false;
  }
}

/** SHA-256 hex of the decoded `skill_md` bytes, the value `content_hash` must carry. */
export function computeSkillContentHash(skillMdBase64: string): string {
  return createHash("sha256").update(Buffer.from(skillMdBase64, "base64")).digest("hex");
}

/**
 * Full authenticity check: signature, then content hash. Returns `null` when
 * the envelope is authentic, otherwise the rejection reason.
 */
export function validateSkillEnvelope(envelope: SkillEnvelope): string | null {
  if (!verifySkillSignature(envelope)) {
    return "invalid Ed25519 signature";
  }
  if (computeSkillContentHash(envelope.skill_md) !== envelope.content_hash) {
    return "content hash mismatch";
  }
  return null;
}
