/**
 * ManagementKeyAuth: thin authorization wrapper over the orchestrator's libp2p
 * Ed25519 keypair.
 *
 * The orchestrator owns the private key material (in `keys/node.key`) and
 * performs all management-action signing via IPC. This class exists to:
 *
 *   1. Discover the orchestrator's pubkey at startup (over IPC)
 *   2. Verify the pubkey is in the genesis trust list
 *   3. Provide a stable public identity handle for the rest of the JS code
 *
 * No private key material ever enters the JS process. Signing is delegated to
 * the Rust orchestrator through `OrchestratorBridge.signAsManagement` (and
 * related helpers). This keeps one canonical identity per node: the same key
 * that libp2p uses for peer identity is what signs management broadcasts and
 * what appears in the trust list.
 *
 * Still exposed for cross-peer verification: `ManagementKeyAuth.verifyCommand`
 * statically verifies an Ed25519-signed envelope from any management peer
 * against a trust list — no local key needed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { OrchestratorBridge } from "../infra/orchestrator-bridge.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/management-key-auth");

export class ManagementKeyAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "KEY_NOT_IN_TRUST_LIST"
      | "TRUST_LIST_EMPTY"
      | "BRIDGE_NOT_READY"
      | "IDENTITY_FETCH_FAILED",
  ) {
    super(message);
    this.name = "ManagementKeyAuthError";
  }
}

export class ManagementKeyAuth {
  /** Base64 encoding of the raw 32-byte Ed25519 public key (the orchestrator's libp2p pubkey). */
  readonly publicKeyBase64: string;
  /** libp2p PeerId derived from the same key — useful for logging and peer-level ops. */
  readonly peerId: string;

  private constructor(publicKeyBase64: string, peerId: string) {
    this.publicKeyBase64 = publicKeyBase64;
    this.peerId = peerId;
  }

  /**
   * Initialize management auth by reading the orchestrator's identity over IPC
   * and verifying the pubkey is in the genesis trust list.
   *
   * Requires the orchestrator bridge to already be connected.
   *
   * @param trustList - Base64 Ed25519 pubkeys from the genesis trust list
   * @param bridge - Connected orchestrator bridge
   * @throws ManagementKeyAuthError when trust list is empty, bridge not connected,
   *         identity fetch fails, or the orchestrator's pubkey is not trusted
   */
  static async init(trustList: string[], bridge: OrchestratorBridge): Promise<ManagementKeyAuth> {
    if (trustList.length === 0) {
      throw new ManagementKeyAuthError(
        "Genesis trust list is empty — cannot authorize management node",
        "TRUST_LIST_EMPTY",
      );
    }
    if (!bridge.isConnected()) {
      throw new ManagementKeyAuthError(
        "Orchestrator bridge is not connected — cannot fetch identity",
        "BRIDGE_NOT_READY",
      );
    }

    let identity: { pubkey: string; peerId: string; nodeTier: string };
    try {
      identity = await bridge.getIdentity();
    } catch (err) {
      throw new ManagementKeyAuthError(
        `Failed to fetch orchestrator identity: ${err instanceof Error ? err.message : String(err)}`,
        "IDENTITY_FETCH_FAILED",
      );
    }

    if (!trustList.includes(identity.pubkey)) {
      log.warn(
        `Orchestrator pubkey (${identity.pubkey}) is not in the genesis trust list. ` +
          `Add this pubkey to your trust list to run as a management node.`,
      );
      throw new ManagementKeyAuthError(
        `Orchestrator pubkey (${identity.pubkey}) is not in the genesis trust list. ` +
          "This node is not authorized to operate as a management node.",
        "KEY_NOT_IN_TRUST_LIST",
      );
    }

    log.info(
      `Management node authorized: pubkey ${identity.pubkey.substring(0, 8)}... (peer ${identity.peerId.substring(0, 16)}...)`,
    );
    return new ManagementKeyAuth(identity.pubkey, identity.peerId);
  }

  /**
   * Statically verify a signed management-command envelope from any peer
   * against a trust list. No local key required.
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
    if (!trustList.includes(envelope.pubkey)) {
      return false;
    }

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
