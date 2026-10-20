/** Run with SOAPBOX_BINARY=/absolute/path/soapbox node --import tsx scripts/soapbox-smoke.ts. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "../src/gateway/server-methods/types.js";
import { SoapboxClient, type SoapboxJob, type SoapboxStatus } from "../src/infra/soapbox-client.js";

const binary = process.env.SOAPBOX_BINARY;
assert.ok(binary && path.isAbsolute(binary), "Set SOAPBOX_BINARY to the compiled executable");
const directory = await mkdtemp(path.join(tmpdir(), "soapbox-smoke-"));
const gpu = process.argv.includes("--gpu");
const keep = gpu && process.argv.includes("--keep");
let gatewayHttpUrl: string | undefined;
const gpuModel = process.env.SOAPBOX_GPU_MODEL ?? "all-minilm:latest";
let modelDigest: string | undefined;
if (gpu) {
  const response = await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, "Local Ollama runtime is required for --gpu");
  const tags = (await response.json()) as { models: Array<{ name: string; digest: string }> };
  modelDigest = tags.models.find((model) => model.name === gpuModel)?.digest;
  assert.match(
    modelDigest ?? "",
    /^[a-f0-9]{64}$/,
    "Install SOAPBOX_GPU_MODEL before running --gpu",
  );
}
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert.ok(address && typeof address !== "string");
await new Promise<void>((resolve) => probe.close(() => resolve()));
const url = `http://127.0.0.1:${address.port}`;
const token = randomBytes(32).toString("hex");
const settings = {
  BITTERBOT_SOAPBOX_ENABLED: "1",
  BITTERBOT_SOAPBOX_URL: url,
  BITTERBOT_SOAPBOX_TOKEN: token,
  BITTERBOT_SOAPBOX_BINARY: binary,
  BITTERBOT_SOAPBOX_CONFIG: path.join(directory, "coordinator.json"),
  BITTERBOT_SOAPBOX_DB: path.join(directory, "state.sqlite"),
  BITTERBOT_SOAPBOX_WORKER_CONFIG: path.join(directory, "worker.json"),
  SOAPBOX_WORKER_TOKEN: randomBytes(32).toString("hex"),
  BITTERBOT_HOME: directory,
  BITTERBOT_STATE_DIR: path.join(directory, "gateway"),
  BITTERBOT_CONFIG_PATH: path.join(directory, "gateway.json"),
  BITTERBOT_EVENT_JOURNAL: "0",
  BITTERBOT_TASKS_DB: path.join(directory, "tasks.sqlite"),
  BITTERBOT_TASKS_COMPLETION_NOTIFY: "0",
  BITTERBOT_TASKS_HORMONAL_GATE: "0",
  BITTERBOT_CHECKPOINTS: "0",
  VITEST: "1",
  BITTERBOT_TEST_MINIMAL_GATEWAY: "1",
};
const old = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
await writeFile(
  settings.BITTERBOT_SOAPBOX_CONFIG,
  JSON.stringify({
    principals: [
      {
        id: "operator",
        token_env: "BITTERBOT_SOAPBOX_TOKEN",
        roles: ["admin", "submitter"],
        pools: ["circle"],
        projects: ["science"],
      },
      {
        id: "worker",
        token_env: "SOAPBOX_WORKER_TOKEN",
        roles: ["worker"],
        pools: ["circle"],
        projects: ["science"],
      },
    ],
  }),
);
await writeFile(
  settings.BITTERBOT_SOAPBOX_WORKER_CONFIG,
  JSON.stringify({
    modes: ["paid", "private", "collective"],
    pools: ["circle"],
    projects: ["science"],
    memory_mib: gpu ? 2048 : 256,
    allow_unsafe_host: true,
    ...(gpu ? { ollama_model: gpuModel, ollama_digest: modelDigest } : {}),
  }),
);
Object.assign(process.env, settings);
const { soapboxHandlers } = await import("../src/gateway/server-methods/soapbox.js");
const { startSoapboxService } = await import("../src/infra/soapbox-service.js");
let stop: (() => Promise<void>) | undefined;
let gateway:
  | Awaited<ReturnType<typeof import("../src/gateway/server.js").startGatewayServer>>
  | undefined;
let socket: InstanceType<typeof import("../src/gateway/client.js").GatewayClient> | undefined;
const receipts: unknown[] = [];

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (socket) return socket.request<T>(method, params);
  let output: unknown;
  let failure: unknown;
  await soapboxHandlers[method]({
    params,
    respond: (ok, value, error) => {
      if (ok) output = value;
      else failure = error;
    },
  } as GatewayRequestHandlerOptions);
  assert.equal(failure, undefined, JSON.stringify(failure));
  return output as T;
}

try {
  stop = await startSoapboxService(process.env);
  if (gpu) {
    const gatewayToken = randomBytes(32).toString("hex");
    await writeFile(
      settings.BITTERBOT_CONFIG_PATH,
      JSON.stringify({
        gateway: {
          mode: "local",
          auth: { mode: "token", token: gatewayToken },
          controlUi: { enabled: keep, root: path.resolve("desktop/dist-renderer") },
        },
        agents: {
          defaults: {
            workspace: path.join(directory, "workspace"),
            memorySearch: { enabled: false },
          },
        },
      }),
    );
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = server.address();
    assert.ok(endpoint && typeof endpoint !== "string");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { startGatewayServer } = await import("../src/gateway/server.js");
    const { GatewayClient } = await import("../src/gateway/client.js");
    gateway = await startGatewayServer(endpoint.port, {
      bind: "loopback",
    });
    gatewayHttpUrl = `http://127.0.0.1:${endpoint.port}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Gateway connect timeout")), 15000);
      socket = new GatewayClient({
        url: `ws://127.0.0.1:${endpoint.port}`,
        token: gatewayToken,
        clientName: "cli",
        mode: "cli",
        scopes: ["operator.admin"],
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.start();
    });
    for (let attempt = 0; attempt < 240; attempt++) {
      const status = await call<SoapboxStatus>("soapbox.status");
      if (status.nodes?.some((node) => node.offer.runtime?.model_digest === modelDigest)) break;
      if (attempt === 239) throw new Error(`GPU not ready: ${JSON.stringify(status.nodes)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const client = new SoapboxClient(url, token);
  await client.request("POST", "/v1/credits", {
    account: "operator",
    amount: 100,
    idempotency_key: "fund",
  });
  const modes = [
    { kind: "private", pool_id: "circle" },
    { kind: "collective", project_id: "science" },
    { kind: "paid", max_cost_credits: gpu ? 33 : 1 },
  ];
  for (const mode of modes) {
    const job = await call<SoapboxJob>("soapbox.submit", {
      idempotency_key: randomUUID(),
      mode,
      workload: gpu
        ? {
            kind: "embeddings",
            model: gpuModel,
            model_digest: modelDigest,
            texts: Array.from(
              { length: 33 },
              (_, i) => `Shared GPU computing for semantic search. Document ${i}.`,
            ),
          }
        : { kind: "sha256", texts: ["gateway to worker"] },
      resources: { cpu_threads: 1, memory_mib: gpu ? 2048 : 256, require_gpu: gpu },
    });
    let result = job;
    for (let attempt = 0; attempt < 480; attempt++) {
      result = await call<SoapboxJob>("soapbox.job", { id: job.id });
      if (result.status === "succeeded") break;
      assert.ok(!["failed", "cancelled"].includes(result.status), JSON.stringify(result));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(result.status, "succeeded");
    if (gpu) {
      const output = result.result as {
        embeddings: number[][];
        execution: { fully_gpu_resident: boolean; model_digest: string; batches: number };
      };
      assert.equal(output.execution.fully_gpu_resident, true);
      assert.equal(output.execution.model_digest, modelDigest);
      assert.equal(output.execution.batches, 3);
      assert.equal(output.embeddings.length, 33);
      assert.ok(output.embeddings.every((row) => row.length > 0 && row.every(Number.isFinite)));
      // Compare a result against a separate direct inference call, not just array shape.
      const referenceResponse = await fetch("http://127.0.0.1:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          model: gpuModel,
          input: ["Shared GPU computing for semantic search. Document 0."],
          truncate: false,
        }),
      });
      assert.ok(referenceResponse.ok);
      const reference = (await referenceResponse.json()) as { embeddings: number[][] };
      const maxDifference = Math.max(
        ...output.embeddings[0].map((value, i) => Math.abs(value - reference.embeddings[0][i])),
      );
      assert.ok(maxDifference < 0.001, `Reference embedding mismatch: ${maxDifference}`);
      receipts.push({
        mode: mode.kind,
        receipt: result.receipt,
        referenceMaxDifference: maxDifference,
      });
    }
  }
  await call("soapbox.worker.pause", { id: "worker", paused: true });
  const pending = await call<SoapboxJob>("soapbox.submit", {
    idempotency_key: randomUUID(),
    mode: { kind: "paid", max_cost_credits: 1 },
    workload: { kind: "sha256", texts: ["cancel me"] },
  });
  await call("soapbox.cancel", { id: pending.id });
  const artifact = await call<{ id: string }>("soapbox.artifact.put", {
    content: "from gateway",
    ttl_seconds: 60,
  });
  assert.equal(
    (await call<{ content: string }>("soapbox.artifact.get", { id: artifact.id })).content,
    "from gateway",
  );
  const status = await client.status();
  assert.equal(status.account?.available_credits, gpu ? 67 : 99);
  assert.equal(status.account?.reserved_credits, 0);
  const report = {
    testedAt: new Date().toISOString(),
    passed: true,
    physicalGpu: gpu,
    liveGatewayWebSocket: gpu,
    gatewayProfile: gpu ? "minimal (unrelated services disabled)" : "direct handlers",
    modes: modes.map((m) => m.kind),
    cancelled: pending.id,
    accounting: status.account,
    managedLifecycle: true,
    receipts,
  };
  if (process.env.SOAPBOX_REPORT)
    await writeFile(process.env.SOAPBOX_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (keep) {
    await call("soapbox.worker.pause", { id: "worker", paused: false });
    console.log(
      `GPU pilot desktop: ${gatewayHttpUrl}. Open Advanced → Compute. Ctrl+C stops this pilot.`,
    );
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        resolve();
      };
      const timer = setTimeout(finish, Number(process.env.SOAPBOX_KEEP_MS ?? 3_600_000));
      process.on("SIGINT", finish);
      process.on("SIGTERM", finish);
    });
  }
} finally {
  socket?.stop();
  await gateway?.close({ reason: "Soapbox smoke test complete" });
  if (gateway) {
    const { stopTaskStore } = await import("../src/tasks/store.js");
    const { stopHormonalAccessor } = await import("../src/tasks/hormonal-accessor.js");
    stopHormonalAccessor();
    stopTaskStore();
  }
  await stop?.();
  for (const [key, value] of old) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Only remove the exact per-run directory created by mkdtemp above.
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("soapbox-smoke-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
