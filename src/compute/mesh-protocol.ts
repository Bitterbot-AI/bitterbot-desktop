import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, type JsonValue } from "../commerce/sku.js";

export const COMPUTE_TOPIC = "bitterbot/compute/v1";
export const DESCRIPTOR_TTL_MS = 120_000;
export const MAX_MESH_FRAME = 768 * 1024;
export const COMPUTE_METHODS = new Set([
  "compute/v1/access",
  "compute/v1/submit",
  "compute/v1/job",
  "compute/v1/cancel",
  "compute/v1/cancel-intent",
]);

export type CancellationReceipt = {
  idempotency_key: string;
  job_id: string | null;
  status: "cancelled" | "succeeded" | "failed";
};
export type ComputeDescriptor = {
  version: 1;
  peerId: string;
  pubkey: string;
  issuedAt: number;
  expiresAt: number;
  region: string;
  accepting: boolean;
  cpuSlots: number;
  gpuSlots: number;
  memoryMib: number;
  models: Array<{ model: string; digest: string }>;
  signature: string;
};
export type MeshBridge = {
  getIdentity(): Promise<{ pubkey: string; peerId: string; nodeTier: string }>;
  signComputeDescriptor(payload: Record<string, unknown>): Promise<string>;
  subscribeCircleTopic(topic: string): Promise<unknown>;
  unsubscribeCircleTopic(topic: string): Promise<unknown>;
  publishCircleTopic(topic: string, dataB64: string): Promise<unknown>;
  onCircleTopicMessage(
    cb: (e: { topic: string; from_peer_id: string; data_b64: string }) => void,
  ): () => void;
  circleRequest(peerId: string, dataB64: string, timeoutMs?: number): Promise<string>;
};

// Ed25519 libp2p PeerIds inline their protobuf public key in an identity multihash.
// Bind the claimed key to the authenticated stream/gossip author; a valid signature
// on an attacker's unrelated key must never impersonate another mesh peer.
export function peerIdForPublicKey(pubkey: string): string {
  const key = Buffer.from(pubkey, "base64");
  if (key.length !== 32 || key.toString("base64") !== pubkey) throw Error("Invalid mesh identity");
  const bytes = Buffer.concat([Buffer.from([0, 36, 8, 1, 18, 32]), key]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt("0x" + bytes.toString("hex")),
    result = "";
  while (value > 0n) {
    result = alphabet[Number(value % 58n)] + result;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}
export function signingBytes(value: Omit<ComputeDescriptor, "signature">): Buffer {
  return Buffer.from(COMPUTE_TOPIC + "\n" + canonicalJson(value as unknown as JsonValue));
}
export function parseDescriptor(
  value: unknown,
  source: string,
  now = Date.now(),
): ComputeDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid compute descriptor");
  const d = value as ComputeDescriptor;
  const fields = [
    "version",
    "peerId",
    "pubkey",
    "issuedAt",
    "expiresAt",
    "region",
    "accepting",
    "cpuSlots",
    "gpuSlots",
    "memoryMib",
    "models",
    "signature",
  ];
  if (
    Object.keys(d).length !== fields.length ||
    Object.keys(d).some((k) => !fields.includes(k)) ||
    d.version !== 1 ||
    d.peerId !== source ||
    typeof d.pubkey !== "string" ||
    peerIdForPublicKey(d.pubkey) !== source ||
    typeof d.accepting !== "boolean" ||
    typeof d.region !== "string" ||
    !/^[a-zA-Z0-9_-]{0,24}$/.test(d.region) ||
    !Number.isSafeInteger(d.issuedAt) ||
    !Number.isSafeInteger(d.expiresAt) ||
    d.issuedAt > now + 15_000 ||
    d.expiresAt <= now ||
    d.expiresAt <= d.issuedAt ||
    d.expiresAt - d.issuedAt > DESCRIPTOR_TTL_MS ||
    ![d.cpuSlots, d.gpuSlots, d.memoryMib].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    d.cpuSlots > 4096 ||
    d.gpuSlots > 256 ||
    d.memoryMib > 16_777_216 ||
    !Array.isArray(d.models) ||
    d.models.length > 16 ||
    d.models.some(
      (m) =>
        !m ||
        typeof m.model !== "string" ||
        m.model.length < 1 ||
        m.model.length > 128 ||
        typeof m.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(m.digest) ||
        Object.keys(m).toSorted().join() !== "digest,model",
    ) ||
    typeof d.signature !== "string" ||
    !/^[a-f0-9]{128}$/.test(d.signature)
  )
    throw Error("Invalid compute descriptor");
  const { signature, ...unsigned } = d;
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(d.pubkey, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, signingBytes(unsigned), key, Buffer.from(signature, "hex")))
    throw Error("Invalid compute signature");
  return d;
}
export function encodeMesh(value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_MESH_FRAME) throw Error("Compute message exceeds mesh limit");
  return bytes.toString("base64");
}
export function decodeMesh(encoded: string): unknown {
  if (encoded.length > Math.ceil(MAX_MESH_FRAME / 3) * 4)
    throw Error("Compute message exceeds mesh limit");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_MESH_FRAME) throw Error("Compute message exceeds mesh limit");
  return JSON.parse(bytes.toString("utf8"));
}
