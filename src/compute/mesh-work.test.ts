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
  expect(db.batch(batch().id)?.shards[0]?.attempts).toBe(0);
  await mesh.stop();
});
it("cancels an ambiguous submission by intent without replaying submit or restoring access", async () => {
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
  mesh.cancel(b.id);
  call.mockRejectedValue(Error("access revoked"));
  const cancel = vi.spyOn(mesh, "cancelRemote").mockResolvedValue({
    idempotency_key: `mesh-${b.id}-0`,
    job_id: null,
    status: "cancelled",
  });
  await advanceBatch(mesh, db.batch(b.id)!);
  const submits = call.mock.calls.filter((c) => c[1].endsWith("/submit"));
  expect(submits).toHaveLength(1);
  expect(cancel).toHaveBeenCalledWith(peer, `mesh-${b.id}-0`);
  expect(db.batch(b.id)?.status).toBe("cancelled");
  db.close();
});

it.each(["offline", "scope denied"])(
  "cancels locally after %s during preflight without sending work",
  async (reason) => {
    const db = new ComputeMeshStore(":memory:");
    const b = batch();
    db.saveBatch(b);
    const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
    const call = vi.spyOn(mesh, "call").mockImplementation(async () => {
      if (reason === "offline") throw Error(reason);
      return { pools: [], projects: [] };
    });
    await advanceBatch(mesh, b);
    expect(db.batch(b.id)?.shards[0]?.attempts).toBe(0);
    mesh.cancel(b.id);
    expect(db.batch(b.id)?.status).toBe("cancelled");
    expect(db.batch(b.id)?.shards[0]?.error).toBeUndefined();
    expect(call.mock.calls.every((c) => c[1] === "compute/v1/access")).toBe(true);
    db.close();
  },
);

it.each([true, false])(
  "does not enqueue if Cancel races an access response (allowed=%s)",
  async (allowed) => {
    const db = new ComputeMeshStore(":memory:");
    const b = batch();
    db.saveBatch(b);
    const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
    let release!: (value: unknown) => void;
    const call = vi.spyOn(mesh, "call").mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const cycle = advanceBatch(mesh, b);
    mesh.cancel(b.id);
    expect(db.batch(b.id)?.status).toBe("cancelled");
    release({ pools: allowed ? ["team"] : [], projects: [] });
    await cycle;
    expect(call).toHaveBeenCalledTimes(1);
    expect(db.batch(b.id)?.status).toBe("cancelled");
    expect(db.batch(b.id)?.shards[0]?.attempts).toBe(0);
    expect(db.batch(b.id)?.shards[0]?.status).toBe("cancelled");
    expect(db.batch(b.id)?.shards[0]?.error).toBeUndefined();
    db.close();
  },
);

it("persists possible dispatch before a lost response and only retries cancellation offline", async () => {
  const db = new ComputeMeshStore(":memory:");
  const b = batch();
  db.saveBatch(b);
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
  const call = vi.spyOn(mesh, "call").mockImplementation(async (_peer, method) => {
    if (method.endsWith("/access")) return { pools: ["team"], projects: [] };
    expect(db.batch(b.id)?.shards[0]?.attempts).toBe(1);
    mesh.cancel(b.id);
    throw Error("response lost");
  });
  const cancel = vi.spyOn(mesh, "cancelRemote").mockRejectedValue(Error("offline"));
  await advanceBatch(mesh, b);
  await advanceBatch(mesh, db.batch(b.id)!);
  expect(db.batch(b.id)?.status).toBe("cancelling");
  expect(db.batch(b.id)?.shards[0]?.error).toContain("will not be resubmitted");
  expect(call).toHaveBeenCalledTimes(2);
  cancel.mockResolvedValue({
    idempotency_key: `mesh-${b.id}-0`,
    job_id: null,
    status: "cancelled",
  });
  await advanceBatch(mesh, db.batch(b.id)!);
  expect(db.batch(b.id)?.status).toBe("cancelled");
  expect(call).toHaveBeenCalledTimes(2);
  db.close();
});

it("reports a completed remote job without claiming its effects were undone", async () => {
  const db = new ComputeMeshStore(":memory:");
  const b = batch();
  b.shards[0].attempts = 1;
  db.saveBatch(b);
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
  vi.spyOn(mesh, "cancelRemote").mockResolvedValue({
    idempotency_key: `mesh-${b.id}-0`,
    job_id: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
  });
  mesh.cancel(b.id);
  await advanceBatch(mesh, db.batch(b.id)!);
  expect(db.batch(b.id)?.status).toBe("cancelled");
  expect(db.batch(b.id)?.shards[0]?.cancelledRemoteStatus).toBe("succeeded");
  expect(db.batch(b.id)?.result).toBeNull();
  db.close();
});
it("refuses every incoming method without a local peer grant", async () => {
  const db = new ComputeMeshStore(":memory:");
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
  expect((await mesh.handle(peer, "compute/v1/submit", {})).ok).toBe(false);
  expect((await mesh.handle(peer, "wallet.send", {})).ok).toBe(false);
  db.close();
});
