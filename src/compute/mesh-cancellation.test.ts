import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SoapboxClient } from "../infra/soapbox-client.js";
import { peerIdForPublicKey, type MeshBridge } from "./mesh-protocol.js";
import { ComputeMeshService } from "./mesh-service.js";
import { ComputeMeshStore, type MeshBatch } from "./mesh-store.js";
import { advanceBatch } from "./mesh-work.js";

const publicKey = randomBytes(32).toString("base64");
const peer = peerIdForPublicKey(publicKey);
const key = "mesh-00000000-0000-4000-8000-000000000000-0";

it("allows only identity-bound cancellation after revocation; never exposes work or grants access", async () => {
  const db = new ComputeMeshStore(":memory:");
  const request = vi
    .fn()
    .mockResolvedValue({ idempotency_key: key, job_id: null, status: "cancelled" });
  const client = vi.fn();
  const mesh = new ComputeMeshService({} as MeshBridge, db, () => ({
    admin: { request } as unknown as SoapboxClient,
    client,
  }));
  const result = await mesh.handle(peer, "compute/v1/cancel-intent", { publicKey, key });
  expect(result.ok).toBe(true);
  expect(request).toHaveBeenCalledWith(
    "POST",
    `/v1/admissions/${Buffer.from(publicKey, "base64").toString("hex")}/cancel`,
    { idempotency_key: key },
  );
  expect(db.permissions()).toEqual([]);
  expect(client).not.toHaveBeenCalled();
  for (const method of ["compute/v1/access", "compute/v1/submit", "compute/v1/job"])
    expect((await mesh.handle(peer, method, {})).ok).toBe(false);
  request.mockClear();
  expect(
    (
      await mesh.handle(
        peerIdForPublicKey(randomBytes(32).toString("base64")),
        "compute/v1/cancel-intent",
        { publicKey, key },
      )
    ).ok,
  ).toBe(false);
  expect(
    (await mesh.handle(peer, "compute/v1/cancel-intent", { publicKey, key: "../../other" })).ok,
  ).toBe(false);
  expect(request).not.toHaveBeenCalled();
  db.close();
});

it("recovers durable legacy/ambiguous cancellation after buyer restart, never replaying submit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-cancel-"));
  const file = path.join(dir, "mesh.sqlite");
  let db = new ComputeMeshStore(file);
  const b: MeshBatch = {
    id: key.slice(5, -2),
    intent: "legacy",
    status: "cancelling",
    createdAt: 1,
    mode: "private",
    scope: "team",
    kind: "sha256",
    inputs: ["x"],
    peers: [peer],
    result: null,
    shards: [{ index: 0, offset: 0, count: 1, peerId: peer, status: "pending", attempts: 1 }],
  };
  db.saveBatch(b);
  db.close();
  db = new ComputeMeshStore(file);
  try {
    const mesh = new ComputeMeshService({} as MeshBridge, db, () => null);
    const call = vi.spyOn(mesh, "call");
    const cancel = vi.spyOn(mesh, "cancelRemote").mockRejectedValue(Error("offline"));
    await advanceBatch(mesh, db.active()[0]);
    expect(db.batch(b.id)?.status).toBe("cancelling");
    cancel.mockResolvedValue({ idempotency_key: key, job_id: null, status: "cancelled" });
    await advanceBatch(mesh, db.active()[0]);
    expect(db.batch(b.id)?.status).toBe("cancelled");
    expect(db.batch(b.id)?.shards[0]?.error).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  { idempotency_key: "wrong", job_id: null, status: "cancelled" },
  { idempotency_key: key, job_id: null, status: "running" },
  { idempotency_key: key, job_id: null, status: "succeeded" },
  { idempotency_key: key, job_id: "forged", status: "cancelled" },
])("rejects an invalid cancellation receipt %j", async (receipt) => {
  const db = new ComputeMeshStore(":memory:");
  const mesh = new ComputeMeshService(
    {
      getIdentity: async () => ({ publicKey, pubkey: publicKey, peerId: peer }),
    } as unknown as MeshBridge,
    db,
    () => null,
  );
  vi.spyOn(mesh, "call").mockResolvedValue(receipt);
  await expect(mesh.cancelRemote(peer, key)).rejects.toThrow("Invalid cancellation");
  db.close();
});
