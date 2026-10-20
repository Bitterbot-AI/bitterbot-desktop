/** Real localhost libp2p + Rust coordinator + isolated worker acceptance test.
 * Runs in Linux/WSL. Uses temporary identities; never loads a wallet or public bootstrap.
 * SOAPBOX_BIN and ORCHESTRATOR_BIN point at the matching development builds.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputeMeshService } from "../src/compute/mesh-service.js";
import { ComputeMeshStore } from "../src/compute/mesh-store.js";
import type { OrchestratorBridge as BridgeType } from "../src/infra/orchestrator-bridge.js";
import { SoapboxClient } from "../src/infra/soapbox-client.js";

const root = await mkdtemp(path.join(tmpdir(), "compute-mesh-e2e-"));
process.env.BITTERBOT_STATE_DIR = path.join(root, "gateway");
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "gateway.json");
await writeFile(process.env.BITTERBOT_CONFIG_PATH, "{}");
const { OrchestratorBridge } = await import("../src/infra/orchestrator-bridge.js");
const { startCircleP2pTransport } = await import("../src/circles/circle-p2p-transport.js");
const children: ChildProcess[] = [];
const workers: Array<{ child: ChildProcess; token: string; url: string; config: string }> = [];
const bridges: BridgeType[] = [];
const meshes: ComputeMeshService[] = [];
const transports: Array<{ stop(): void }> = [];
const base = process.env.MESH_TEST_PORT ? Number(process.env.MESH_TEST_PORT) : 29240;
const minimalEnv = { PATH: process.env.PATH, HOME: root };
async function save(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
function launch(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const log = createWriteStream(path.join(root, `child-${children.length}.log`), { mode: 0o600 });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", () => log.end());
  let errors = "";
  child.stderr?.on("data", (b) => {
    errors = (errors + b.toString()).slice(-2000);
  });
  child.on("error", () => {});
  child.on("exit", (code) => {
    if (code) process.stderr.write(`Test child exited ${code}: ${errors}\n`);
  });
  return child;
}
async function until(fn: () => Promise<boolean>, label: string, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(500);
  }
  throw Error(`Timed out: ${label}`);
}
async function completedBatch(mesh: ComputeMeshService, id: string): Promise<boolean> {
  const status = mesh.store.batch(id)?.status;
  assert(
    !["failed", "cancelled"].includes(status ?? ""),
    `Batch ${id} ended ${status}; see ${root}`,
  );
  return status === "succeeded";
}
try {
  const workerConfig = JSON.parse(
    await readFile(
      process.env.SOAPBOX_SANDBOX_CONFIG ?? "/mnt/d/Bitterbot/soapbox/.local/worker-isolated.json",
      "utf8",
    ),
  );
  assert(
    workerConfig.sandbox && !workerConfig.allow_unsafe_host,
    "Isolated worker configuration required",
  );
  const backend = [];
  for (let i = 0; i < 3; i++) {
    console.log(`Starting isolated test node ${i}`);
    const dir = path.join(root, String(i));
    await mkdir(path.join(dir, "keys"), { recursive: true });
    await writeFile(path.join(dir, "keys/node.key"), randomBytes(32), { mode: 0o600 });
    let local = null;
    if (i > 0) {
      const admin = randomBytes(32).toString("hex"),
        worker = randomBytes(32).toString("hex");
      await save(path.join(dir, "coordinator.json"), {
        principals: [
          {
            id: "admin",
            token_env: "MESH_ADMIN",
            roles: ["admin", "submitter"],
            pools: ["circle"],
            projects: ["science"],
          },
          {
            id: "worker",
            token_env: "MESH_WORKER",
            roles: ["worker"],
            pools: ["circle"],
            projects: ["science"],
          },
        ],
      });
      const url = `http://127.0.0.1:${base + i}`;
      const adminClient = new SoapboxClient(url, admin);
      launch(
        process.env.SOAPBOX_BIN ?? "/tmp/soapbox-target/debug/soapbox",
        [
          "serve",
          "--config",
          path.join(dir, "coordinator.json"),
          "--db",
          path.join(dir, "runtime.db"),
          "--bind",
          `127.0.0.1:${base + i}`,
        ],
        { ...minimalEnv, MESH_ADMIN: admin, MESH_WORKER: worker },
      );
      await until(
        async () => Boolean(await adminClient.status().catch(() => null)),
        "coordinator start",
      );
      await save(path.join(dir, "worker.json"), {
        ...workerConfig,
        memory_mib: 256,
        ollama_model: null,
        ollama_digest: null,
        modes: ["private", "collective"],
        pools: ["circle"],
        projects: ["science"],
        pause_file: path.join(dir, "PAUSE"),
      });
      const workerChild = launch(
        process.env.SOAPBOX_BIN ?? "/tmp/soapbox-target/debug/soapbox",
        [
          "worker",
          "--config",
          path.join(dir, "worker.json"),
          "--coordinator",
          url,
          "--token-env",
          "MESH_WORKER",
        ],
        { ...minimalEnv, MESH_WORKER: worker },
      );
      workers.push({
        child: workerChild,
        token: worker,
        url,
        config: path.join(dir, "worker.json"),
      });
      local = { admin: adminClient, client: (token: string) => new SoapboxClient(url, token) };
      await until(
        async () => (await adminClient.status()).nodes?.some((n) => n.online) ?? false,
        "isolated worker registration",
      );
    }
    backend.push(local);
    process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH = path.join(dir, "p2p.sock");
    const bootstrap =
      i === 0
        ? []
        : [`/ip4/127.0.0.1/tcp/${base + 10}/p2p/${(await bridges[0]!.getIdentity()).peerId}`];
    const bridge = new OrchestratorBridge({
      enabled: true,
      orchestratorBinary:
        process.env.ORCHESTRATOR_BIN ?? "/tmp/bitterbot-mesh-target/debug/bitterbot-orchestrator",
      keyDir: path.join(dir, "keys"),
      listenAddrs: [`/ip4/127.0.0.1/tcp/${base + 10 + i}`],
      httpAddr: `127.0.0.1:${base + 20 + i}`,
      bootstrapPeers: bootstrap,
      relayMode: "off",
    });
    bridges.push(bridge);
    await bridge.start();
    await until(async () => bridge.isConnected(), "IPC connection");
    const mesh = new ComputeMeshService(
      bridge,
      new ComputeMeshStore(path.join(dir, "mesh.db")),
      () => local,
    );
    meshes.push(mesh);
    await mesh.start();
    transports.push(
      startCircleP2pTransport({ bridge, resolveCirclesDb: async () => undefined, compute: mesh }),
    );
  }
  const buyer = meshes[0]!;
  const buyerId = (await bridges[0]!.getIdentity()).peerId;
  await until(
    async () => meshes.every((m) => m.status().peers.length === 2),
    "signed gossip discovery",
  );
  const peerIds = await Promise.all(
    bridges.slice(1).map(async (b) => (await b.getIdentity()).peerId),
  );
  await assert.rejects(buyer.call(peerIds[0]!, "compute/v1/access", {}));
  for (const mesh of meshes.slice(1)) await mesh.grant(buyerId, ["circle"], ["science"]);
  const input = Array.from({ length: 40 }, (_, i) => `Private mesh input ${i}`);
  await until(
    async () =>
      peerIds.every((id) => buyer.store.peers().some((p) => p.peerId === id && p.accepting)),
    "CPU capacity discovery",
  );
  const b = buyer.submit({
    intent: "cpu-private-e2e",
    kind: "sha256",
    mode: "private",
    scope: "circle",
    inputs: input,
    peers: peerIds,
  });
  await until(async () => completedBatch(buyer, b.id), "multi-operator CPU batch");
  const completed = buyer.store.batch(b.id)!;
  assert.equal(new Set(completed.shards.map((s) => s.peerId)).size, 2);
  assert.equal((completed.result as { hashes: string[] }).hashes.length, 40);
  const again = buyer.submit({
    intent: "cpu-private-e2e",
    kind: "sha256",
    mode: "private",
    scope: "circle",
    inputs: input,
    peers: peerIds,
  });
  assert.equal(again.id, b.id);
  const collective = buyer.submit({
    intent: "cpu-collective-e2e",
    kind: "sha256",
    mode: "collective",
    scope: "science",
    inputs: input,
    peers: peerIds,
  });
  await until(async () => completedBatch(buyer, collective.id), "collective batch");
  // Gateway restart retains batches and resumes work with the same intent.
  const recover = buyer.submit({
    intent: "cpu-recovery-e2e",
    kind: "sha256",
    mode: "private",
    scope: "circle",
    inputs: input,
    peers: peerIds,
  });
  transports[0]!.stop();
  await buyer.stop();
  const recovered = new ComputeMeshService(
    bridges[0]!,
    new ComputeMeshStore(path.join(root, "0/mesh.db")),
    () => null,
  );
  meshes[0] = recovered;
  transports[0] = startCircleP2pTransport({
    bridge: bridges[0]!,
    resolveCirclesDb: async () => undefined,
    compute: recovered,
  });
  await recovered.start();
  await until(async () => completedBatch(recovered, recover.id), "restart recovery");
  console.log("CPU private, collective and restart recovery passed; starting isolated GPU worker");
  const gpuWorker = workers[0]!;
  if (gpuWorker.child.exitCode === null && gpuWorker.child.signalCode === null) {
    gpuWorker.child.kill("SIGTERM");
    await until(
      async () => gpuWorker.child.exitCode !== null || gpuWorker.child.signalCode !== null,
      "CPU worker shutdown",
      10000,
    );
  }
  await save(gpuWorker.config, {
    ...workerConfig,
    modes: ["private", "collective"],
    pools: ["circle"],
    projects: ["science"],
    pause_file: path.join(root, "1/PAUSE"),
  });
  launch(
    process.env.SOAPBOX_BIN ?? "/tmp/soapbox-target/debug/soapbox",
    [
      "worker",
      "--config",
      gpuWorker.config,
      "--coordinator",
      gpuWorker.url,
      "--token-env",
      "MESH_WORKER",
    ],
    { ...minimalEnv, MESH_WORKER: gpuWorker.token },
  );
  await until(
    async () =>
      recovered.store.peers().some((p) => p.accepting && p.gpuSlots > 0 && p.models.length > 0),
    "GPU readiness discovery",
    180000,
  );
  const advertised = recovered.store
    .peers()
    .find((p) => p.accepting && p.gpuSlots > 0 && p.models.length);
  assert(advertised, "GPU model capacity must be advertised");
  const model = advertised.models[0]!;
  const gpu = recovered.submit({
    intent: "gpu-p2p-e2e",
    kind: "embeddings",
    mode: "private",
    scope: "circle",
    inputs: ["Bitterbot pooled GPU computation", "Private data stays off gossip"],
    peers: [advertised.peerId],
    model: model.model,
    digest: model.digest,
  });
  await until(async () => completedBatch(recovered, gpu.id), "GPU job over encrypted P2P", 180000);
  await meshes[1]!.revoke(buyerId);
  await assert.rejects(recovered.call(peerIds[0]!, "compute/v1/access", {}));
  const report = {
    test: "real-libp2p-isolated-compute",
    root,
    peers: 3,
    operatorCoordinators: 2,
    cpuInputs: 40,
    privateBatch: b.id,
    collectiveBatch: collective.id,
    recoveryBatch: recover.id,
    gpuBatch: gpu.id,
    gpuResult: recovered.store.batch(gpu.id)?.result,
    admissionAndRevocation: true,
    mainnetWalletAccessed: false,
    paymentsMade: false,
  };
  await save(path.join(root, "result.json"), report);
  console.log(
    JSON.stringify(
      { ...report, gpuResult: "2 embedding rows; full result in protected report" },
      null,
      2,
    ),
  );
} finally {
  for (const t of transports) t.stop();
  for (const m of meshes) await m.stop().catch(() => {});
  for (const b of bridges) await b.stop().catch(() => {});
  for (const c of children) c.kill("SIGTERM");
  await delay(1000);
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
}
