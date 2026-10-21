/** Real loopback libp2p + Rust coordinator cancellation fault matrix.
 * Synthetic CPU lease driver; no GPU, wallet, public bootstrap or main profile.
 * Usage: SOAPBOX_BIN=... ORCHESTRATOR_BIN=... node --import tsx scripts/compute-cancellation-e2e.ts output.json
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MeshBatch } from "../src/compute/mesh-store.js";
import type { OrchestratorBridge as Bridge } from "../src/infra/orchestrator-bridge.js";
import type { SoapboxJob } from "../src/infra/soapbox-client.js";

type RuntimeJob = SoapboxJob & {
  lease_id: string;
  spec: SoapboxJob["spec"] & { idempotency_key: string };
};

const binary = process.env.SOAPBOX_BIN,
  orchestrator = process.env.ORCHESTRATOR_BIN;
const output = process.argv[2];
assert(binary && orchestrator && output, "SOAPBOX_BIN, ORCHESTRATOR_BIN and output path required");
const root = await mkdtemp(path.join(tmpdir(), "compute-cancellation-"));
process.env.HOME = root;
process.env.BITTERBOT_STATE_DIR = root;
process.env.BITTERBOT_CONFIG_PATH = path.join(root, "gateway.json");
await writeFile(process.env.BITTERBOT_CONFIG_PATH, "{}");
const { OrchestratorBridge } = await import("../src/infra/orchestrator-bridge.js");
const { SoapboxClient } = await import("../src/infra/soapbox-client.js");
const { ComputeMeshService } = await import("../src/compute/mesh-service.js");
const { ComputeMeshStore } = await import("../src/compute/mesh-store.js");
const { advanceBatch } = await import("../src/compute/mesh-work.js");
const { COMPUTE_TOPIC, encodeMesh, decodeMesh } = await import("../src/compute/mesh-protocol.js");
const { startCircleP2pTransport } = await import("../src/circles/circle-p2p-transport.js");
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function until(check: () => Promise<boolean>, label: string, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  throw Error(`Timeout: ${label}`);
}
const token = randomBytes(32).toString("hex"),
  workerToken = randomBytes(32).toString("hex");
const port = await freePort(),
  url = `http://127.0.0.1:${port}`;
const config = path.join(root, "coordinator.json");
await writeFile(
  config,
  JSON.stringify({
    principals: [
      {
        id: "admin",
        token_env: "TEST_ADMIN",
        roles: ["admin", "submitter"],
        pools: ["team"],
        projects: [],
      },
      { id: "worker", token_env: "TEST_WORKER", roles: ["worker"], pools: ["team"], projects: [] },
    ],
  }),
  { mode: 0o600 },
);
const admin = new SoapboxClient(url, token),
  worker = new SoapboxClient(url, workerToken);
let coordinator: ChildProcess | undefined;
async function startCoordinator() {
  const log = createWriteStream(path.join(root, "coordinator.log"), { flags: "a", mode: 0o600 });
  coordinator = spawn(
    binary!,
    [
      "serve",
      "--config",
      config,
      "--db",
      path.join(root, "runtime.sqlite"),
      "--bind",
      `127.0.0.1:${port}`,
    ],
    {
      env: { PATH: process.env.PATH, HOME: root, TEST_ADMIN: token, TEST_WORKER: workerToken },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  coordinator.stdout!.pipe(log, { end: false });
  coordinator.stderr!.pipe(log, { end: false });
  coordinator.once("close", () => log.end());
  await until(async () => !!(await admin.status(500).catch(() => null)), "runtime start");
}
async function stopCoordinator() {
  if (coordinator && coordinator.exitCode === null) {
    const stopped = new Promise<void>((r) => coordinator!.once("close", () => r()));
    coordinator.kill("SIGTERM");
    await stopped;
  }
}
type TestNode = {
  dir: string;
  port: number;
  http: number;
  bridge: Bridge;
  identity: Awaited<ReturnType<Bridge["getIdentity"]>>;
};
async function startNode(
  name: string,
  bootstrap: string[],
  existing?: TestNode,
): Promise<TestNode> {
  const dir = path.join(root, name);
  if (!existing) {
    await mkdir(path.join(dir, "keys"), { recursive: true });
    await writeFile(path.join(dir, "keys/node.key"), randomBytes(32), { mode: 0o600 });
  }
  const listen = existing?.port ?? (await freePort()),
    http = existing?.http ?? (await freePort());
  process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH = path.join(dir, "p2p.sock");
  const bridge = new OrchestratorBridge({
    enabled: true,
    orchestratorBinary: orchestrator,
    keyDir: path.join(dir, "keys"),
    listenAddrs: [`/ip4/127.0.0.1/tcp/${listen}`],
    httpAddr: `127.0.0.1:${http}`,
    relayMode: "off",
    bootstrapPeers: bootstrap,
    bootstrapDns: "",
  });
  await bridge.start();
  await until(async () => bridge.isConnected(), "sidecar IPC");
  return { dir, port: listen, http, bridge, identity: await bridge.getIdentity() };
}
const backend = () => ({
  admin,
  client: (credential: string) => new SoapboxClient(url, credential),
});
let op: TestNode | undefined, buyer: TestNode | undefined;
let operator: InstanceType<typeof ComputeMeshService> | undefined;
let buying: InstanceType<typeof ComputeMeshService> | undefined;
let transport: ReturnType<typeof startCircleP2pTransport> | undefined;
const trials: Array<{ scenario: string; passed: boolean; elapsedMs: number }> = [];
let submissions = 0,
  dropSubmitReply = false;
const remoteJobs = new Map<string, string>();
const fixture = (): MeshBatch => ({
  id: randomUUID(),
  intent: randomUUID(),
  createdAt: Date.now(),
  mode: "private",
  scope: "team",
  kind: "sha256",
  status: "running",
  inputs: ["synthetic cancellation probe"],
  peers: [op!.identity.peerId],
  result: null,
  shards: [
    { index: 0, offset: 0, count: 1, peerId: op!.identity.peerId, status: "pending", attempts: 0 },
  ],
});
const key = (batch: MeshBatch) => `mesh-${batch.id}-0`;
const spec = (batch: MeshBatch) => ({
  idempotency_key: key(batch),
  mode: { kind: "private", pool_id: "team" },
  workload: { kind: "sha256", texts: batch.inputs },
  resources: { cpu_threads: 1, memory_mib: 256, require_gpu: false },
});
async function announceBuyer() {
  const now = Date.now();
  const unsigned = {
    version: 1,
    peerId: buyer!.identity.peerId,
    pubkey: buyer!.identity.pubkey,
    issuedAt: now,
    expiresAt: now + 120000,
    region: "",
    accepting: false,
    cpuSlots: 0,
    gpuSlots: 0,
    memoryMib: 0,
    models: [],
  };
  const message = { ...unsigned, signature: await buyer!.bridge.signComputeDescriptor(unsigned) };
  await until(async () => {
    await buyer!.bridge
      .publishCircleTopic(COMPUTE_TOPIC, encodeMesh(message))
      .catch(() => undefined);
    return operator!.store.peers().some((p) => p.peerId === buyer!.identity.peerId);
  }, "signed buyer discovery");
}
async function grant() {
  await announceBuyer();
  await operator!.grant(buyer!.identity.peerId, ["team"], []);
}
async function revoke() {
  await operator!.revoke(buyer!.identity.peerId);
}
async function stopOperator() {
  transport?.stop();
  await operator?.stop();
  await op?.bridge.stop();
}
async function restartOperator() {
  op = await startNode(
    "operator",
    [`/ip4/127.0.0.1/tcp/${buyer!.port}/p2p/${buyer!.identity.peerId}`],
    op,
  );
  operator = new ComputeMeshService(
    op.bridge,
    new ComputeMeshStore(path.join(op.dir, "mesh.sqlite")),
    backend,
  );
  transport = startCircleP2pTransport({
    bridge: op.bridge,
    resolveCirclesDb: async () => undefined,
    compute: operator,
  });
  await operator.start();
  await announceBuyer();
}
async function recreateBuyer(automatic: boolean) {
  await buying!.stop();
  buying = new ComputeMeshService(
    buyer!.bridge,
    new ComputeMeshStore(path.join(buyer!.dir, "mesh.sqlite")),
    () => null,
  );
  if (automatic) await buying.start();
  else await buyer!.bridge.subscribeCircleTopic(COMPUTE_TOPIC);
}
async function queued() {
  const b = fixture();
  buying!.store.saveBatch(b);
  await advanceBatch(buying!, b);
  assert(buying!.store.batch(b.id)!.shards[0].jobId, "real runtime job expected");
  return b;
}
async function claim() {
  await worker.request("POST", "/v1/workers/register", {
    cpu_threads: 1,
    memory_mib: 256,
    gpu_observed: false,
    models: [],
    modes: ["private"],
    pools: ["team"],
    projects: [],
  });
  const job = await worker.request<RuntimeJob | null>("POST", "/v1/workers/claim", {});
  assert(job);
  return job;
}
async function scenario(name: string, body: () => Promise<void>) {
  const start = Date.now();
  await body();
  trials.push({ scenario: name, passed: true, elapsedMs: Date.now() - start });
  console.log(JSON.stringify(trials.at(-1)));
}
let passed = false;
try {
  await startCoordinator();
  op = await startNode("operator", []);
  buyer = await startNode("buyer", [`/ip4/127.0.0.1/tcp/${op.port}/p2p/${op.identity.peerId}`]);
  const nativeRequest = buyer.bridge.circleRequest.bind(buyer.bridge);
  buyer.bridge.circleRequest = async (peer, frame, timeout) => {
    const request = decodeMesh(frame) as {
      method: string;
      params: { spec?: { idempotency_key: string } };
    };
    if (request.method === "compute/v1/submit") submissions++;
    const response = await nativeRequest(peer, frame, timeout);
    if (request.method === "compute/v1/submit") {
      const reply = decodeMesh(response) as { ok: boolean; result?: { id: string } };
      if (reply.ok && reply.result)
        remoteJobs.set(request.params.spec!.idempotency_key, reply.result.id);
      if (dropSubmitReply) {
        dropSubmitReply = false;
        throw Error("injected lost submit response AFTER actual coordinator acceptance");
      }
    }
    return response;
  };
  buying = new ComputeMeshService(
    buyer.bridge,
    new ComputeMeshStore(path.join(buyer.dir, "mesh.sqlite")),
    () => null,
  );
  await buyer.bridge.subscribeCircleTopic(COMPUTE_TOPIC);
  operator = new ComputeMeshService(
    op.bridge,
    new ComputeMeshStore(path.join(op.dir, "mesh.sqlite")),
    backend,
  );
  transport = startCircleP2pTransport({
    bridge: op.bridge,
    resolveCirclesDb: async () => undefined,
    compute: operator,
  });
  await operator.start();
  await announceBuyer();

  await scenario("offline_preflight_cancels_locally_without_dispatch", async () => {
    await stopOperator();
    const b = fixture();
    buying!.store.saveBatch(b);
    await advanceBatch(buying!, b);
    assert.equal(b.shards[0].attempts, 0);
    buying!.cancel(b.id);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelled");
    assert.equal(submissions, 0);
    await restartOperator();
  });
  await scenario("refused_preflight_cancels_without_requesting_a_grant", async () => {
    const b = fixture();
    buying!.store.saveBatch(b);
    await advanceBatch(buying!, b);
    buying!.cancel(b.id);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelled");
    assert.equal(submissions, 0);
    assert.deepEqual(operator!.store.permissions(), []);
  });
  await scenario(
    "lost_submit_reply_then_revocation_cancels_without_replay_or_readmission",
    async () => {
      await grant();
      const b = fixture();
      buying!.store.saveBatch(b);
      dropSubmitReply = true;
      await advanceBatch(buying!, b);
      assert(remoteJobs.has(key(b)));
      assert(!b.shards[0].jobId);
      await revoke();
      const sent = submissions;
      buying!.cancel(b.id);
      await advanceBatch(buying!, buying!.store.batch(b.id)!);
      assert.equal(buying!.store.batch(b.id)!.status, "cancelled");
      assert.equal(submissions, sent);
      assert.deepEqual(operator!.store.permissions(), []);
      await assert.rejects(buying!.call(op!.identity.peerId, "compute/v1/access", {}));
      await grant();
      await assert.rejects(
        buying!.call(op!.identity.peerId, "compute/v1/submit", { spec: spec(b) }),
      );
      await revoke();
    },
  );
  await scenario("cancel_before_delayed_submission_fences_future_enqueue", async () => {
    await grant();
    const b = fixture();
    b.shards[0].attempts = 1;
    buying!.store.saveBatch(b);
    buying!.cancel(b.id);
    await advanceBatch(buying!, buying!.store.batch(b.id)!);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelled");
    await assert.rejects(buying!.call(op!.identity.peerId, "compute/v1/submit", { spec: spec(b) }));
    assert(
      !(await admin.request<{ jobs: RuntimeJob[] }>("GET", "/v1/status")).jobs?.some(
        (j) => j.spec.idempotency_key === key(b),
      ),
    );
    await revoke();
  });
  await scenario("running_job_revoked_then_cancelled_rejects_late_worker_results", async () => {
    await grant();
    const b = await queued();
    const lease = await claim();
    assert.equal(lease.id, b.shards[0].jobId);
    await revoke();
    buying!.cancel(b.id);
    await advanceBatch(buying!, buying!.store.batch(b.id)!);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelled");
    await assert.rejects(
      worker.request("POST", `/v1/jobs/${lease.id}/renew`, { lease_id: lease.lease_id }),
    );
    await assert.rejects(
      worker.request("POST", `/v1/jobs/${lease.id}/complete`, {
        lease_id: lease.lease_id,
        result: { hashes: b.inputs.map((t) => createHash("sha256").update(t).digest("hex")) },
      }),
    );
  });
  await scenario("coordinator_outage_and_buyer_restart_recover_automatically", async () => {
    await grant();
    const b = await queued();
    const sent = submissions;
    await stopCoordinator();
    buying!.cancel(b.id);
    await advanceBatch(buying!, buying!.store.batch(b.id)!);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelling");
    await recreateBuyer(true);
    await startCoordinator();
    await until(
      async () => buying!.store.batch(b.id)!.status === "cancelled",
      "automatic runtime recovery",
    );
    assert.equal(submissions, sent);
    await recreateBuyer(false);
    await revoke();
  });
  await scenario("p2p_operator_process_restart_recovers_pending_cancellation", async () => {
    await grant();
    const b = await queued();
    const sent = submissions;
    await stopOperator();
    buying!.cancel(b.id);
    await advanceBatch(buying!, buying!.store.batch(b.id)!);
    assert.equal(buying!.store.batch(b.id)!.status, "cancelling");
    await restartOperator();
    await recreateBuyer(true);
    await until(
      async () => buying!.store.batch(b.id)!.status === "cancelled",
      "automatic peer recovery",
    );
    assert.equal(submissions, sent);
    await recreateBuyer(false);
    await revoke();
  });
  await scenario("completed_work_is_reported_without_undo_or_result_disclosure", async () => {
    await grant();
    const b = await queued();
    const lease = await claim();
    await worker.request("POST", `/v1/jobs/${lease.id}/complete`, {
      lease_id: lease.lease_id,
      result: { hashes: b.inputs.map((t) => createHash("sha256").update(t).digest("hex")) },
    });
    await revoke();
    buying!.cancel(b.id);
    await advanceBatch(buying!, buying!.store.batch(b.id)!);
    const result = buying!.store.batch(b.id)!;
    assert.equal(result.status, "cancelled");
    assert.equal(result.shards[0].cancelledRemoteStatus, "succeeded");
    assert.equal(result.result, null);
  });
  await scenario("authenticated_peer_cannot_cancel_using_another_public_key", async () => {
    await assert.rejects(
      buying!.call(op!.identity.peerId, "compute/v1/cancel-intent", {
        publicKey: op!.identity.pubkey,
        key: key(fixture()),
      }),
    );
    assert.deepEqual(operator!.store.permissions(), []);
  });
  assert(
    (await admin.request<{ jobs: RuntimeJob[] }>("GET", "/v1/status")).jobs?.every((j) =>
      ["succeeded", "cancelled", "failed"].includes(j.status),
    ),
  );
  passed = true;
} finally {
  await buying?.stop();
  await stopOperator();
  await buyer?.bridge.stop();
  await stopCoordinator();
  await writeFile(
    output,
    JSON.stringify(
      {
        passed,
        trials,
        physicalHosts: 1,
        transport: "real loopback libp2p",
        runtime: "real Rust coordinator",
        worker: "synthetic CPU lease driver",
        walletsLoaded: false,
        paymentsMade: false,
        profile: root,
      },
      null,
      2,
    ) + "\n",
  );
}
assert(passed);
