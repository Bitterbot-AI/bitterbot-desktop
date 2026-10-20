/**
 * minisign signature verification in TypeScript (PLAN-56 Phase 3b).
 *
 * The in-place tarball updater verifies a release's `checksums.txt` with the
 * same rules as scripts/install.sh, but always with node:crypto: Node can
 * always check an Ed25519 signature, so unlike install.sh there is no
 * "SHA-256 over HTTPS only" tier here. Any failure throws (fail closed).
 *
 * Format (https://jedisct1.github.io/minisign/):
 *   public key payload  = "Ed" | key_id(8) | ed25519_pub(32)        (42 bytes)
 *   .minisig line 1     = "untrusted comment: ..."
 *   .minisig line 2     = base64( alg(2) | key_id(8) | signature(64) )  (74 bytes)
 *   .minisig line 3     = "trusted comment: <text>"
 *   .minisig line 4     = base64( global_signature(64) )
 * alg "ED" (the default since minisign 0.8) signs BLAKE2b-512(file); the
 * legacy "Ed" signs the raw file. The global signature covers
 * signature || trusted_comment, which binds the trusted comment (and so the
 * release tag) to the signature.
 *
 * The same checks exist in scripts/orchestrator-signature.mjs (orchestrator
 * postinstall, plain JS) and in install.sh's OpenSSL path; the unit tests run
 * all of them against the same vectors (the real orchestrator-v0.2.3
 * signature and throwaway-key signatures from src/test-utils/minisign.ts).
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * The pinned release-signing key: the base64 payload of the minisign .pub
 * file's second line, key id 310E141334FF6D4. It is the same key as
 * ORCHESTRATOR_MINISIGN_PUBKEY in scripts/orchestrator-signature.mjs and
 * PINNED_PUBKEY in scripts/install.sh; minisign.test.ts fails if the three
 * ever differ, so rotating the key is one PR that changes all three. It is
 * never read from the environment outside the updater's test mode.
 */
export const RELEASE_MINISIGN_PUBKEY = "RWTU9k8zQeEQA5GbldCYMA7kgR3nwoLbtjhw5FWMGiwu+h72OMk2Ne04";

/** DER prefix that turns a raw 32-byte Ed25519 key into SPKI for node:crypto. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class MinisignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinisignError";
  }
}

export type MinisignPublicKey = { keyId: Buffer; rawKey: Buffer };

export function parseMinisignPublicKey(pubkeyB64: string): MinisignPublicKey {
  const trimmed = pubkeyB64.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    throw new MinisignError("public key is not base64");
  }
  const pub = Buffer.from(trimmed, "base64");
  if (pub.length !== 42 || pub.toString("latin1", 0, 2) !== "Ed") {
    throw new MinisignError("public key is not a minisign Ed25519 key");
  }
  return { keyId: Buffer.from(pub.subarray(2, 10)), rawKey: Buffer.from(pub.subarray(10, 42)) };
}

/** The key id as minisign prints it (hex, most significant byte first). */
export function formatMinisignKeyId(keyId: Buffer): string {
  // A plain loop, not toReversed(): the npm launcher bundles this module and
  // supports Node 18, which lacks the change-array-by-copy methods.
  const reversed = Buffer.alloc(keyId.length);
  for (let i = 0; i < keyId.length; i += 1) {
    reversed[i] = keyId[keyId.length - 1 - i]!;
  }
  return reversed.toString("hex").toUpperCase();
}

type ParsedSignature = {
  algorithm: "ED" | "Ed";
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
};

function decodeBase64Strict(value: string, what: string): Buffer {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    throw new MinisignError(`${what} is not base64`);
  }
  return Buffer.from(trimmed, "base64");
}

/**
 * Parse a .minisig file. Exactly the four-line layout minisign writes (a
 * trailing newline and CRLF line ends are tolerated); anything else is
 * refused rather than guessed at.
 */
export function parseMinisignSignature(text: string): ParsedSignature {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length !== 4) {
    throw new MinisignError("malformed .minisig file (expected 4 lines)");
  }
  const [untrusted, sigLine, trustedLine, globalLine] = lines as [string, string, string, string];
  if (!untrusted.startsWith("untrusted comment:")) {
    throw new MinisignError("malformed .minisig file (no untrusted comment line)");
  }
  const trustedPrefix = "trusted comment: ";
  if (!trustedLine.startsWith(trustedPrefix)) {
    throw new MinisignError("malformed .minisig file (no trusted comment line)");
  }
  const blob = decodeBase64Strict(sigLine, "signature");
  if (blob.length !== 74) {
    throw new MinisignError("malformed minisign signature payload");
  }
  const algorithm = blob.toString("latin1", 0, 2);
  if (algorithm !== "ED" && algorithm !== "Ed") {
    throw new MinisignError(`unknown minisign signature algorithm "${algorithm}"`);
  }
  const globalSignature = decodeBase64Strict(globalLine, "global signature");
  if (globalSignature.length !== 64) {
    throw new MinisignError("malformed minisign global signature");
  }
  return {
    algorithm,
    keyId: Buffer.from(blob.subarray(2, 10)),
    signature: Buffer.from(blob.subarray(10, 74)),
    trustedComment: trustedLine.slice(trustedPrefix.length),
    globalSignature,
  };
}

/**
 * Verify `minisig` over `message` with `pubkeyB64`. Returns the trusted
 * comment (covered by the global signature) on success; throws a
 * MinisignError naming the first check that failed otherwise.
 */
export function verifyMinisignSignature(params: {
  pubkeyB64: string;
  message: Buffer | string;
  minisig: string;
}): { trustedComment: string; algorithm: "ED" | "Ed" } {
  const key = parseMinisignPublicKey(params.pubkeyB64);
  const sig = parseMinisignSignature(params.minisig);
  if (!sig.keyId.equals(key.keyId)) {
    throw new MinisignError(
      `signature key id ${formatMinisignKeyId(sig.keyId)} does not match the pinned key ${formatMinisignKeyId(key.keyId)}`,
    );
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key.rawKey]),
    format: "der",
    type: "spki",
  });
  const message = Buffer.isBuffer(params.message)
    ? params.message
    : Buffer.from(params.message, "utf8");
  const signed =
    sig.algorithm === "ED" ? createHash("blake2b512").update(message).digest() : message;
  if (!cryptoVerify(null, signed, publicKey, sig.signature)) {
    throw new MinisignError("signature is INVALID for the pinned key");
  }
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!cryptoVerify(null, globalMessage, publicKey, sig.globalSignature)) {
    throw new MinisignError("trusted comment (global) signature is INVALID");
  }
  return { trustedComment: sig.trustedComment, algorithm: sig.algorithm };
}

/** The trusted comment a release's checksums.txt is signed with (release-tarball.yml). */
export function releaseChecksumsComment(version: string): string {
  return `v${version} checksums`;
}

/**
 * Parse sha256sum-formatted text and return the hash for exactly `filename`
 * (same grammar as scripts/release-tarball-lib.mjs parseShasums).
 */
export function lookupSha256(checksums: string, filename: string): string | null {
  for (const rawLine of checksums.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[2] === filename) {
      return match[1]!.toLowerCase();
    }
  }
  return null;
}
