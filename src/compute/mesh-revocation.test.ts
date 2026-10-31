import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SoapboxClient } from "../infra/soapbox-client.js";
import { peerIdForPublicKey, type MeshBridge } from "./mesh-protocol.js";
import { ComputeMeshService } from "./mesh-service.js";
import { ComputeMeshStore, type MeshGrant } from "./mesh-store.js";

function grant(): MeshGrant {
  const pubkey = randomBytes(32).toString("base64");
  return {
    peerId: peerIdForPublicKey(pubkey),
    pubkey,
    principal: `mesh_${Buffer.from(pubkey, "base64").toString("hex")}`,
    token: randomBytes(32).toString("hex"),
    pools: ["team"],
    projects: [],
    enabled: true,
  };
}
function setup(db: ComputeMeshStore) {
  const admin = new SoapboxClient("http://127.0.0.1:1", "a".repeat(64));
  const request = vi.spyOn(admin, "request").mockRejectedValue(Error("offline"));
  vi.spyOn(admin, "status").mockResolvedValue({ enabled: true, nodes: [] });
  const bridge = { unsubscribeCircleTopic: async () => ({ ok: true }) } as unknown as MeshBridge;
  const mesh = new ComputeMeshService(bridge, db, () => ({ admin, client: () => admin }));
  return { mesh, request };
}
it("keeps denial durable, then retries revocation after restart without discovery or manual action", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mesh-revoke-test-"));
  try {
    const file = path.join(dir, "mesh.sqlite"),
      g = grant();
    const first = setup(new ComputeMeshStore(file));
    first.mesh.store.saveGrant(g);
    await expect(first.mesh.revoke(g.peerId)).rejects.toThrow("offline");
    expect((await first.mesh.handle(g.peerId, "compute/v1/access", {})).ok).toBe(false);
    expect(first.mesh.status().error).toContain("retry automatically");
    await first.mesh.stop();
    const restored = setup(new ComputeMeshStore(file));
    expect(restored.mesh.store.grant(g.peerId)?.enabled).toBe(false);
    await restored.mesh.tick();
    expect(restored.mesh.store.pendingRevocations()).toHaveLength(1);
    restored.request.mockResolvedValue({ revoked: true });
    await restored.mesh.tick();
    expect(restored.mesh.store.grant(g.peerId)).toBeUndefined();
    expect(restored.request).toHaveBeenCalledWith(
      "POST",
      expect.stringMatching(/\/revoke$/),
      {},
      3000,
    );
    expect(restored.mesh.store.recent().some((a) => a.kind === "access_revoked")).toBe(true);
    await restored.mesh.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("does not let an unavailable first revocation starve other peers", async () => {
  const { mesh, request } = setup(new ComputeMeshStore(":memory:"));
  const grants = Array.from({ length: 6 }, () => ({ ...grant(), enabled: false }));
  grants.forEach((g) => mesh.store.saveGrant(g));
  request.mockImplementation(async (_method, url) => {
    if (url.includes(Buffer.from(grants[0]!.pubkey, "base64").toString("hex")))
      throw Error("unavailable");
    return { revoked: true };
  });
  await mesh.tick();
  await mesh.tick();
  await mesh.tick();
  expect(mesh.store.pendingRevocations().map((g) => g.peerId)).toEqual([grants[0]!.peerId]);
  await mesh.stop();
});
it("serializes pending cleanup before a new grant and rotates its credential", async () => {
  const { mesh, request } = setup(new ComputeMeshStore(":memory:"));
  const g = grant();
  mesh.store.saveGrant({ ...g, enabled: false });
  mesh.store.peer({
    version: 1,
    peerId: g.peerId,
    pubkey: g.pubkey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 120000,
    region: "",
    accepting: false,
    cpuSlots: 0,
    gpuSlots: 0,
    memoryMib: 0,
    models: [],
    signature: "a".repeat(128),
  });
  let release!: () => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ revoked: true });
      }),
  );
  const cleanup = mesh.tick();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const regrant = mesh.grant(g.peerId, ["team"], []);
  request.mockResolvedValue({});
  release();
  await cleanup;
  await regrant;
  expect(request.mock.calls.map((c) => c[1])).toEqual([
    expect.stringMatching(/\/revoke$/),
    "/v1/admissions",
  ]);
  expect(mesh.store.grant(g.peerId)?.enabled).toBe(true);
  const firstToken = mesh.store.grant(g.peerId)!.token;
  expect(firstToken).not.toBe(g.token);
  await mesh.grant(g.peerId, ["other"], []);
  expect(mesh.store.grant(g.peerId)!.token).not.toBe(firstToken);
  await mesh.stop();
});
