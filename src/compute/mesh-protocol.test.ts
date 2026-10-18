import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  parseDescriptor,
  peerIdForPublicKey,
  signingBytes,
  encodeMesh,
  decodeMesh,
  DESCRIPTOR_TTL_MS,
} from "./mesh-protocol.js";
import { ComputeMeshStore } from "./mesh-store.js";
function descriptor(now = Date.now(), models: Array<{ model: string; digest: string }> = []) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubkey = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64");
  const unsigned = {
    version: 1 as const,
    peerId: peerIdForPublicKey(pubkey),
    pubkey,
    issuedAt: now,
    expiresAt: now + DESCRIPTOR_TTL_MS,
    region: "",
    accepting: true,
    cpuSlots: 1,
    gpuSlots: 0,
    memoryMib: 128,
    models,
  };
  return { ...unsigned, signature: sign(null, signingBytes(unsigned), privateKey).toString("hex") };
}
describe("Compute discovery", () => {
  it("binds signature, transport author, expiry and exact metadata schema", () => {
    const d = descriptor();
    expect(parseDescriptor(decodeMesh(encodeMesh(d)), d.peerId)).toEqual(d);
    expect(() => parseDescriptor(d, descriptor().peerId)).toThrow();
    expect(() => parseDescriptor({ ...d, gpuSlots: 100 }, d.peerId)).toThrow();
    expect(() => parseDescriptor(d, d.peerId, d.expiresAt)).toThrow();
    expect(() => parseDescriptor({ ...d, inputs: ["private"] }, d.peerId)).toThrow();
    expect(() => parseDescriptor({ ...d, region: undefined }, d.peerId)).toThrow();
    const malformed = descriptor(Date.now(), [
      { model: "model", digest: ["a".repeat(64)] as unknown as string },
    ]);
    expect(() => parseDescriptor(malformed, malformed.peerId)).toThrow();
  });
  it("does not let an older advertisement overwrite current capacity", () => {
    const db = new ComputeMeshStore(":memory:");
    const d = descriptor();
    db.peer(d);
    db.peer({ ...d, issuedAt: d.issuedAt - 1, gpuSlots: 100 });
    expect(db.peers()[0]?.gpuSlots).toBe(0);
    expect(db.peers(d.expiresAt)).toEqual([]);
    db.close();
  });
  it("bounds transport frames before JSON decoding", () => {
    expect(() => decodeMesh("A".repeat(2 * 1024 * 1024))).toThrow();
    expect(() => encodeMesh({ text: "x".repeat(800 * 1024) })).toThrow();
  });
});
