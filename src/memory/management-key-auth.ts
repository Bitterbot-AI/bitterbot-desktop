/**
 * ManagementKeyAuth: Ed25519 cryptographic authorization for management nodes.
 *
 * Management nodes must prove they hold a private key whose corresponding
 * public key is listed in the genesis trust list. Without this proof,
 * a node cannot operate as a management node regardless of config.
 *
 * Key material flow:
 *   BITTERBOT_MANAGEMENT_KEY env var (base64 Ed25519 seed/private key)
 *     → derive public key
 *     → verify pubkey is in genesis trust list
 *     → sign management commands with private key
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/management-key-auth");

export class ManagementKeyAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "KEY_MISSING"
      | "KEY_INVALID"
      | "KEY_NOT_IN_TRUST_LIST"
      | "TRUST_LIST_EMPTY"
      | "SIGN_FAILED",
  ) {
    super(message);
    this.name = "ManagementKeyAuthError";
  }
}

export class ManagementKeyAuth {
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKey: crypto.KeyObject;
  /** Base64 encoding of the raw 32-byte Ed25519 public key. */
  readonly publicKeyBase64: string;

  private constructor(
    privateKey: crypto.KeyObject,
    publicKey: crypto.KeyObject,
    publicKeyBase64: string,
  ) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicKeyBase64 = publicKeyBase64;
  }

  /**
   * Initialize management key auth from environment and trust list.
   *
   * @param trustList - Array of base64 Ed25519 pubkeys from the genesis trust list
   * @param envKeyOverride - Optional override for testing (bypasses process.env)
   * @throws ManagementKeyAuthError if key is missing, invalid, or not in trust list
   */
  static init(trustList: string[], envKeyOverride?: string): ManagementKeyAuth {
    if (trustList.length === 0) {
      throw new ManagementKeyAuthError(
        "Genesis trust list is empty — cannot authorize management node",
        "TRUST_LIST_EMPTY",
      );
    }

    const keyBase64 = envKeyOverride ?? process.env.BITTERBOT_MANAGEMENT_KEY;
    if (!keyBase64) {
      throw new ManagementKeyAuthError(
        "BITTERBOT_MANAGEMENT_KEY environment variable is not set. " +
          "Management nodes require an Ed25519 private key for authorization.",
        "KEY_MISSING",
      );
    }

    // Decode the base64 key material
    let seedBytes: Buffer;
    try {
      seedBytes = Buffer.from(keyBase64, "base64");
    } catch {
      throw new ManagementKeyAuthError(
        "BITTERBOT_MANAGEMENT_KEY is not valid base64",
        "KEY_INVALID",
      );
    }

    // Ed25519 seed is 32 bytes; some encodings include the full 64-byte private key
    // (seed + public key). We accept both.
    if (seedBytes.length !== 32 && seedBytes.length !== 64) {
      throw new ManagementKeyAuthError(
        `BITTERBOT_MANAGEMENT_KEY has invalid length (${seedBytes.length} bytes). ` +
          "Expected 32-byte seed or 64-byte private key.",
        "KEY_INVALID",
      );
    }

    // Use only the first 32 bytes (seed) if 64 bytes provided
    const seed = seedBytes.length === 64 ? seedBytes.subarray(0, 32) : seedBytes;

    let privateKey: crypto.KeyObject;
    let publicKey: crypto.KeyObject;
    let rawPubBytes: Buffer;
    try {
      // Import the seed as a PKCS8 Ed25519 private key
      // Node.js expects Ed25519 in PKCS8 DER format for import
      const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const pkcs8Der = Buffer.concat([pkcs8Prefix, seed]);
      privateKey = crypto.createPrivateKey({
        key: pkcs8Der,
        format: "der",
        type: "pkcs8",
      });
      publicKey = crypto.createPublicKey(privateKey);

      // Extract raw 32-byte public key from SPKI DER
      const spkiDer = publicKey.export({ format: "der", type: "spki" });
      // SPKI for Ed25519 is 44 bytes: 12-byte header + 32-byte key
      rawPubBytes = Buffer.from(spkiDer.subarray(12));
    } catch (err) {
      throw new ManagementKeyAuthError(
        `Failed to load Ed25519 key: ${err instanceof Error ? err.message : String(err)}`,
        "KEY_INVALID",
      );
    }

    const publicKeyBase64 = rawPubBytes.toString("base64");

    // Verify the derived public key is in the genesis trust list
    if (!trustList.includes(publicKeyBase64)) {
      log.warn(`Management key's public key (${publicKeyBase64}) is not in the genesis trust list`);
      throw new ManagementKeyAuthError(
        "Management key's public key is not in the genesis trust list. " +
          "This node is not authorized to operate as a management node.",
        "KEY_NOT_IN_TRUST_LIST",
      );
    }

    log.info(`Management key authorized: pubkey ${publicKeyBase64.substring(0, 8)}...`);
    return new ManagementKeyAuth(privateKey, publicKey, publicKeyBase64);
  }

  /**
   * Sign arbitrary data with the management private key.
   * Returns the signature as a base64 string.
   */
  sign(data: Buffer | string): string {
    try {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      const sig = crypto.sign(null, buf, this.privateKey);
      return sig.toString("base64");
    } catch (err) {
      throw new ManagementKeyAuthError(
        `Signing failed: ${err instanceof Error ? err.message : String(err)}`,
        "SIGN_FAILED",
      );
    }
  }

  /**
   * Verify a signature against this node's public key.
   * Useful for round-trip validation.
   */
  verify(data: Buffer | string, signatureBase64: string): boolean {
    try {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      const sig = Buffer.from(signatureBase64, "base64");
      return crypto.verify(null, buf, this.publicKey, sig);
    } catch {
      return false;
    }
  }

  /**
   * Create a signed management command envelope.
   * Includes the command, timestamp, pubkey, and signature.
   */
  signCommand(
    command: string,
    payload: Record<string, unknown>,
  ): {
    command: string;
    payload: Record<string, unknown>;
    timestamp: number;
    pubkey: string;
    signature: string;
  } {
    const timestamp = Date.now();
    const canonical = JSON.stringify({ command, payload, timestamp });
    const signature = this.sign(canonical);
    return {
      command,
      payload,
      timestamp,
      pubkey: this.publicKeyBase64,
      signature,
    };
  }

  /**
   * Verify a signed command envelope from another management node.
   * Checks both signature validity and that the pubkey is in the trust list.
   */
  static verifyCommand(
    envelope: {
      command: string;
      payload: Record<string, unknown>;
      timestamp: number;
      pubkey: string;
      signature: string;
    },
    trustList: string[],
  ): boolean {
    // Pubkey must be in trust list
    if (!trustList.includes(envelope.pubkey)) return false;

    // Reconstruct canonical form and verify signature
    const canonical = JSON.stringify({
      command: envelope.command,
      payload: envelope.payload,
      timestamp: envelope.timestamp,
    });

    try {
      const pubkeyBytes = Buffer.from(envelope.pubkey, "base64");
      const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
      const spkiDer = Buffer.concat([spkiPrefix, pubkeyBytes]);
      const publicKey = crypto.createPublicKey({
        key: spkiDer,
        format: "der",
        type: "spki",
      });
      const sigBytes = Buffer.from(envelope.signature, "base64");
      return crypto.verify(null, Buffer.from(canonical), publicKey, sigBytes);
    } catch {
      return false;
    }
  }
}

/**
 * Load the genesis trust list from a file path or inline array.
 * File format: one base64 pubkey per line, blank lines and # comments ignored.
 */
export function loadGenesisTrustList(filePath?: string, inlineList?: string[]): string[] {
  const result: string[] = [];

  if (inlineList && inlineList.length > 0) {
    result.push(...inlineList);
  }

  if (filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          result.push(trimmed);
        }
      }
    } catch (err) {
      log.warn(`Failed to read genesis trust list from ${filePath}: ${String(err)}`);
    }
  }

  // Deduplicate
  return [...new Set(result)];
}
