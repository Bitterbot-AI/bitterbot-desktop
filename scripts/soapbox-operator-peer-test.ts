/** Submit real peer workloads to the operator enabled through the packaged desktop UI. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputeMeshSnapshot } from "../src/compute/mesh-types.js";
import { ComputeMeshService } from "../src/compute/mesh-service.js";
import { ComputeMeshStore } from "../src/compute/mesh-store.js";
import { GatewayClient } from "../src/gateway/client.js";

const profile = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const config = JSON.parse(await readFile(profile.configFile, "utf8"));
assert(config.plugins.entries["soapbox-compute"].config.mode === "mesh-operator");
const root = await mkdtemp(path.join(tmpdir(), "soapbox-rc5-peer-"));
process.env.BITTERBOT_STATE_DIR = root;
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "gateway.json");
process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH = path.join(root, "p2p.sock");
await writeFile(process.env.BITTERBOT_CONFIG_PATH, "{}");
await mkdir(path.join(root, "keys"));
await writeFile(path.join(root, "keys/node.key"), randomBytes(32), { mode: 0o600 });
async function until(fn: () => Promise<boolean>, name: string, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(1000);
  }
  throw new Error(`Timed out: ${name}`);
}
let gateway!: GatewayClient;
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Gateway connection timeout")), 60000);
  gateway = new GatewayClient({
    url: `ws://127.0.0.1:${profile.port}`,
    token: config.gateway.auth.token,
    clientName: "cli",
    mode: "cli",
    scopes: ["operator.admin"],
    onHelloOk: () => {
      clearTimeout(timer);
      resolve();
    },
    onConnectError: (e) => {
      clearTimeout(timer);
      reject(e);
    },
  });
  gateway.start();
});
const snapshot = await gateway.request<ComputeMeshSnapshot>("soapbox.mesh.status", {});
console.log(
  JSON.stringify({ ready: snapshot.ready, hosting: snapshot.hosting, error: snapshot.error }),
);
assert(snapshot.hosting && snapshot.peerId);
const { OrchestratorBridge } = await import("../src/infra/orchestrator-bridge.js");
const { startCircleP2pTransport } = await import("../src/circles/circle-p2p-transport.js");
const bridge = new OrchestratorBridge({
  enabled: true,
  orchestratorBinary: config.p2p.orchestratorBinary,
  keyDir: path.join(root, "keys"),
  listenAddrs: ["/ip4/127.0.0.1/tcp/29283"],
  httpAddr: "127.0.0.1:29284",
  relayMode: "off",
  bootstrapPeers: [`/ip4/127.0.0.1/tcp/29281/p2p/${snapshot.peerId}`],
});
let mesh: ComputeMeshService | undefined, transport: { stop(): void } | undefined;
try {
  await bridge.start();
  await until(async () => bridge.isConnected(), "buyer transport");
  mesh = new ComputeMeshService(
    bridge,
    new ComputeMeshStore(path.join(root, "mesh.sqlite")),
    () => null,
  );
  await mesh.start();
  transport = startCircleP2pTransport({
    bridge,
    resolveCirclesDb: async () => undefined,
    compute: mesh,
  });
  const peerId = (await bridge.getIdentity()).peerId;
  await until(
    async () => mesh!.status().peers.some((p) => p.peerId === snapshot.peerId),
    "signed operator discovery",
  );
  await assert.rejects(mesh.call(snapshot.peerId, "compute/v1/access", {}));
  await until(
    async () =>
      (await gateway.request<ComputeMeshSnapshot>("soapbox.mesh.status", {})).peers.some(
        (p) => p.peerId === peerId,
      ),
    "operator discovers buyer",
  );
  await gateway.request("soapbox.mesh.grant", {
    peerId,
    pools: ["private"],
    projects: ["community"],
  });
  const batches = [];
  for (const mode of ["private", "collective"] as const) {
    const batch = mesh.submit({
      intent: randomUUID(),
      mode,
      scope: mode === "private" ? "private" : "community",
      kind: "sha256",
      inputs: ["one-click operator", mode],
      peers: [snapshot.peerId],
    });
    await until(async () => {
      const b = mesh!.store.batch(batch.id)!;
      assert(!["failed", "cancelled"].includes(b.status));
      return b.status === "succeeded";
    }, `${mode} CPU batch`);
    batches.push({ kind: "sha256", mode, id: batch.id });
  }
  await until(
    async () =>
      mesh!
        .status()
        .peers.some((p) => p.peerId === snapshot.peerId && p.gpuSlots > 0 && p.models.length > 0),
    "GPU capacity",
  );
  const model = mesh.status().peers.find((p) => p.peerId === snapshot.peerId)!.models[0]!;
  const gpu = mesh.submit({
    intent: randomUUID(),
    mode: "private",
    scope: "private",
    kind: "embeddings",
    model: model.model,
    digest: model.digest,
    inputs: ["P2P GPU acceptance", "A ready operator from the desktop wizard"],
    peers: [snapshot.peerId],
  });
  await until(
    async () => {
      const b = mesh!.store.batch(gpu.id)!;
      assert(!["failed", "cancelled"].includes(b.status));
      return b.status === "succeeded";
    },
    "isolated GPU batch",
    300000,
  );
  batches.push({ kind: "embeddings", mode: "private", id: gpu.id });
  await gateway.request("soapbox.mesh.revoke", { peerId });
  await assert.rejects(mesh.call(snapshot.peerId, "compute/v1/access", {}));
  const report = {
    test: "packaged-operator-peer-flow",
    passed: true,
    batches,
    admissionAndRevocation: true,
    paymentsMade: false,
    physicalHosts: 1,
  };
  await writeFile(
    path.join(profile.root, "peer-acceptance.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  transport?.stop();
  await mesh?.stop();
  await bridge.stop();
  gateway.stop();
}
