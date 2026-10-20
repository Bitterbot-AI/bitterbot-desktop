import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { peerIdForPublicKey, signingBytes, type MeshBridge } from "./mesh-protocol.js";
import { ComputeMeshService } from "./mesh-service.js";
import { ComputeMeshStore, type MeshBatch } from "./mesh-store.js";
import { advanceBatch, validateBatch, verifyShard } from "./mesh-work.js";
const peer = peerIdForPublicKey(randomBytes(32).toString("base64"));
const batch = (): MeshBatch => ({
  id: "00000000-0000-4000-8000-000000000000",
  intent: "test-intent",
  createdAt: Date.now(),
  status: "running",
  mode: "private",
  scope: "team",
  kind: "sha256",
  inputs: ["hello"],
  peers: [peer],
  result: null,
  shards: [{ index: 0, offset: 0, count: 1, peerId: peer, status: "pending", attempts: 0 }],
});
it("rejects malformed and paid batches and unverified results", () => {
  const { intent, mode, scope, kind, inputs, peers } = batch();
  const request = { intent, mode, scope, kind, inputs, peers };
  expect(() => validateBatch(request)).not.toThrow();
  expect(() => validateBatch({ ...request, mode: "paid" as "private" })).toThrow();
  expect(() => validateBatch({ ...request, model: "unrequested" })).toThrow();
  expect(() => validateBatch({ ...request, peers: [peer, peer] })).toThrow();
  expect(() => validateBatch({ ...request, inputs: ["x".repeat(33000)] })).toThrow();
  expect(() => verifyShard(batch(), 0, 1, { hashes: ["forged"] })).toThrow();
  const b = { ...batch(), kind: "embeddings" as const, model: "model", digest: "a".repeat(64) };
  expect(() =>
    verifyShard(b, 0, 1, { embeddings: [[1, 2]], execution: { model: "other" } }),
  ).toThrow();
});
it("continues durable work when capacity gossip has no reachable subscribers", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubkey = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("base64");
  const bridge = {
    getIdentity: async () => ({ pubkey, peerId: peerIdForPublicKey(pubkey) }),
    onCircleTopicMessage: () => () => {},
    subscribeCircleTopic: async () => ({ ok: true }),
    unsubscribeCircleTopic: async () => ({ ok: true }),
    signComputeDescriptor: async (d: Parameters<typeof signingBytes>[0]) =>
      sign(null, signingBytes(d), privateKey).toString("hex"),
    publishCircleTopic: async () => ({ ok: false }),
  } as unknown as MeshBridge;
  const db = new ComputeMeshStore(":memory:");
  db.saveBatch(batch());
  const mesh = new ComputeMeshService(bridge, db, () => null);
  const call = vi.spyOn(mesh, "call").mockRejectedValue(Error("offline"));
  await mesh.start();
  expect(mesh.status().ready).toBe(false);
  expect(call).toHaveBeenCalled();
  expect(db.batch(batch().id)?.shards[0]?.attempts).toBe(1);
  await mesh.stop();
});
it("retries an ambiguous submission with the same key after recovery and recovers before cancelling", async () => {
  const db = new ComputeMeshStore(":memory:");
  const b = batch();
  db.saveBatch(b);
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
  const call = vi.spyOn(mesh, "call").mockImplementation(async (_peer, method) => {
    if (method.endsWith("/access")) return { pools: ["team"], projects: [] };
    throw Error("response lost");
  });
  await advanceBatch(mesh, b);
  expect(db.batch(b.id)?.shards[0]?.attempts).toBe(1);
  const first = call.mock.calls.find((c) => c[1].endsWith("/submit"))?.[2];
  mesh.cancel(b.id);
  call.mockImplementation(async (_peer, method) =>
    method.endsWith("/access")
      ? { pools: ["team"], projects: [] }
      : { id: "11111111-1111-4111-8111-111111111111", status: "cancelled", result: null },
  );
  await advanceBatch(mesh, db.batch(b.id)!);
  const submits = call.mock.calls.filter((c) => c[1].endsWith("/submit"));
  expect(submits[1]?.[2]).toEqual(first);
  expect(call.mock.calls.some((c) => c[1].endsWith("/cancel"))).toBe(true);
  expect(db.batch(b.id)?.status).toBe("cancelled");
  db.close();
});
it("refuses every incoming method without a local peer grant", async () => {
  const db = new ComputeMeshStore(":memory:");
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
  expect((await mesh.handle(peer, "compute/v1/submit", {})).ok).toBe(false);
  expect((await mesh.handle(peer, "wallet.send", {})).ok).toBe(false);
  db.close();
});
