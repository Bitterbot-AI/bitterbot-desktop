/** Full gateway -> isolated worker -> escrow pilot. --testnet uses separate CDP test accounts. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SoapboxJob, SoapboxStatus } from "../src/infra/soapbox-client.js";
import type { SoapboxPaymentQuote } from "../src/services/soapbox-payment.js";

const binary = process.env.SOAPBOX_BINARY;
const repo = process.env.SOAPBOX_REPO;
assert.ok(
  binary && repo && path.isAbsolute(binary) && path.isAbsolute(repo),
  "Set SOAPBOX_BINARY and SOAPBOX_REPO",
);
const workerConfig = JSON.parse(
  await readFile(
    process.env.SOAPBOX_SANDBOX_CONFIG ?? path.join(repo, ".local/worker-isolated.json"),
    "utf8",
  ),
);
assert.ok(workerConfig.sandbox, "An isolated worker configuration is required");
const gpu = process.argv.includes("--gpu");
const testnet = process.argv.includes("--testnet");
type Tx = { to?: `0x${string}`; data: `0x${string}`; value?: bigint };
type Testnet = {
  rpcUrl: string;
  accounts: Record<string, string>;
  escrow?: string;
  escrowCodeHash?: string;
  send: (role: string, tx: Tx) => Promise<string>;
};
type Pilot = {
  config: Record<string, unknown>;
  records: unknown[];
  initial: string;
  accounts: Record<string, string>;
  fund: (quote: SoapboxPaymentQuote) => Promise<void>;
  balance: () => Promise<string>;
  relay: (url: string, token: string, crashAfterPayout?: boolean) => Promise<() => Promise<void>>;
  close: () => Promise<void>;
};
let network: Testnet | undefined;
if (testnet) {
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const liveConfig = JSON.parse(
    await readFile(path.join(homedir(), ".bitterbot/bitterbot.json"), "utf8"),
  );
  const cfg = liveConfig.tools?.wallet ?? {};
  process.env.CDP_API_KEY_ID ??= cfg.cdpApiKeyId;
  process.env.CDP_API_KEY_SECRET ??= cfg.cdpApiKeySecret;
  const cdp = new CdpClient({
    apiKeyId: cfg.cdpApiKeyId ?? process.env.CDP_API_KEY_ID,
    apiKeySecret: cfg.cdpApiKeySecret ?? process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
  const accounts = JSON.parse(
    await readFile(path.join(repo, ".local/testnet-accounts.json"), "utf8"),
  ) as Record<string, string>;
  network = {
    rpcUrl: "https://sepolia.base.org",
    accounts,
    send: async (role, transaction) => {
      if (!transaction.to) {
        // CDP currently rejects contract-creation transactions with an empty `to`.
        // A faucet-funded, ephemeral test-only deployer creates the escrow; buyer
        // funding and operator settlement still use the actual CDP wallet paths.
        const { createWalletClient, createPublicClient, http } = await import("viem");
        const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
        const { baseSepolia } = await import("viem/chains");
        const account = privateKeyToAccount(generatePrivateKey());
        accounts.deployer = account.address;
        const publicClient = createPublicClient({
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });
        const faucet = await cdp.evm.requestFaucet({
          address: account.address,
          network: "base-sepolia",
          token: "eth",
        });
        console.log("Test-only deployer funded", {
          address: account.address,
          transactionHash: faucet.transactionHash,
        });
        await publicClient.waitForTransactionReceipt({
          hash: faucet.transactionHash,
          confirmations: 2,
        });
        const wallet = createWalletClient({
          account,
          chain: baseSepolia,
          transport: http("https://sepolia.base.org"),
        });
        try {
          return await wallet.sendTransaction(transaction);
        } catch (error) {
          const causes = [];
          let current: unknown = error;
          for (let n = 0; current && n < 6; n++) {
            const detail = current as {
              name?: string;
              details?: string;
              errorMessage?: string;
              shortMessage?: string;
              cause?: unknown;
            };
            causes.push({
              name: detail.name,
              message: (detail.details ?? detail.errorMessage ?? detail.shortMessage)?.slice(
                0,
                800,
              ),
            });
            current = detail.cause;
          }
          throw new Error(`Testnet deployment failed: ${JSON.stringify(causes)}`, { cause: error });
        }
      }
      const result = await cdp.evm.sendTransaction({
        address: accounts[role] as `0x${string}`,
        network: "base-sepolia",
        transaction,
      });
      return result.transactionHash;
    },
  };
  if (process.env.SOAPBOX_TESTNET_REUSE_REPORT) {
    const previous = JSON.parse(await readFile(process.env.SOAPBOX_TESTNET_REUSE_REPORT, "utf8"));
    assert.equal(previous.chain.chain_id, 84532);
    network.escrow = previous.chain.escrow;
    network.escrowCodeHash = previous.chain.escrow_code_sha256;
  }
}
const module = (await import(pathToFileURL(path.join(repo, "settlement/pilot.mjs")).href)) as {
  createPilot: (network?: Testnet) => Promise<Pilot>;
};
console.log("Deploying isolated payment pilot", { testnet, gpu });
const pilot = await module.createPilot(network);
const directory = await mkdtemp(path.join(tmpdir(), "soapbox-payment-"));
const freePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};
const port = await freePort();
const token = randomBytes(32).toString("hex");
const settings = {
  BITTERBOT_SOAPBOX_ENABLED: "1",
  BITTERBOT_SOAPBOX_URL: `http://127.0.0.1:${port}`,
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
const previous = new Map(Object.keys(settings).map((key) => [key, process.env[key]]));
Object.assign(process.env, settings);
await writeFile(
  settings.BITTERBOT_SOAPBOX_CONFIG,
  JSON.stringify({
    payments: pilot.config,
    principals: [
      {
        id: "buyer",
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
    ...workerConfig,
    modes: ["paid", "private", "collective"],
    pools: ["circle"],
    projects: ["science"],
  }),
);
const gatewayToken = randomBytes(32).toString("hex");
if (testnet) {
  process.env.BITTERBOT_SOAPBOX_ESCROW = String(pilot.config.escrow);
  process.env.BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256 = String(pilot.config.escrow_code_sha256);
  process.env.BITTERBOT_SOAPBOX_RPC_URL = String(pilot.config.rpc_url);
}
await writeFile(
  settings.BITTERBOT_CONFIG_PATH,
  JSON.stringify({
    tools: {
      wallet: {
        enabled: testnet,
        network: "base-sepolia",
        walletStorePath: path.join(directory, "test-wallet"),
        perTransactionCapUsd: 0.1,
        dailySpendLimitUsd: 1,
      },
    },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: { workspace: path.join(directory, "workspace"), memorySearch: { enabled: false } },
    },
  }),
);
let stop: (() => Promise<void>) | undefined;
let gateway:
  | Awaited<ReturnType<typeof import("../src/gateway/server.js").startGatewayServer>>
  | undefined;
let socket: InstanceType<typeof import("../src/gateway/client.js").GatewayClient> | undefined;
const report: Record<string, unknown> = {
  testnet,
  gpu,
  chain: pilot.config,
  accounts: pilot.accounts,
  operator_before_microusdc: pilot.initial,
  transactions: pilot.records,
};
const output = process.env.SOAPBOX_REPORT ?? path.join(repo, ".local/payment-validation.json");
const saveReport = () => writeFile(output, JSON.stringify(report, null, 2));
await saveReport();
try {
  const { startSoapboxService } = await import("../src/infra/soapbox-service.js");
  stop = await startSoapboxService();
  const gatewayPort = await freePort();
  const { startGatewayServer } = await import("../src/gateway/server.js");
  const { GatewayClient } = await import("../src/gateway/client.js");
  gateway = await startGatewayServer(gatewayPort, { bind: "loopback" });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Gateway connect timeout")), 15000);
    socket = new GatewayClient({
      url: `ws://127.0.0.1:${gatewayPort}`,
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
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    socket!.request<T>(method, params);
  let ready = false;
  for (let n = 0; n < 180; n++) {
    const status = await call<SoapboxStatus>("soapbox.status");
    if (
      status.nodes?.some(
        (node) => node.offer.isolation === "docker_v1" && (!gpu || node.offer.gpu_observed),
      )
    ) {
      ready = true;
      break;
    }
    if (n % 20 === 0) console.log("Waiting for isolated worker", status.nodes);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "Isolated worker must be ready");
  let relay = await pilot.relay(settings.BITTERBOT_SOAPBOX_URL, token, true);
  let recoveredPayout = false;
  const modes = [
    { kind: "private", pool_id: "circle" },
    { kind: "collective", project_id: "science" },
    { kind: "paid_usdc", operator: "worker", max_cost_microusdc: 100000 },
  ];
  const results: SoapboxJob[] = [];
  for (const mode of modes) {
    console.log("Submitting isolated workload", mode.kind);
    const job = await call<SoapboxJob>("soapbox.submit", {
      idempotency_key: randomUUID(),
      mode,
      workload: gpu
        ? {
            kind: "embeddings",
            model: workerConfig.ollama_model,
            model_digest: workerConfig.ollama_digest,
            texts: Array.from(
              { length: 33 },
              (_, i) => `Isolated distributed compute document ${i}`,
            ),
          }
        : { kind: "sha256", texts: ["isolated buyer to operator"] },
      resources: { cpu_threads: 1, memory_mib: gpu ? 2048 : 256, require_gpu: gpu },
    });
    report.current_job = job;
    await saveReport();
    if (job.payment) {
      console.log("Funding escrow", { id: job.id, amount_microusdc: job.payment.amount_microusdc });
      assert.equal(job.status, "awaiting_payment");
      assert.equal(await pilot.balance(), pilot.initial);
      if (testnet) {
        const funding = await socket!.request<{
          funding: { txHash: string | null; status: string };
        }>("soapbox.payment.fund", { id: job.id });
        report.buyer_funding = funding.funding;
        await saveReport();
      } else await pilot.fund(job.payment);
      await call("soapbox.payment.refresh", { id: job.id });
    }
    let current = job;
    for (let n = 0; n < 180; n++) {
      try {
        await relay();
      } catch (error) {
        if (recoveredPayout || !String(error).includes("injected crash after confirmed payout"))
          throw error;
        recoveredPayout = true;
        console.log(
          "Recovering settlement after confirmed payout, before coordinator acknowledgement",
        );
        relay = await pilot.relay(settings.BITTERBOT_SOAPBOX_URL, token);
      }
      current = await call<SoapboxJob>("soapbox.job", { id: job.id });
      if (current.status === "succeeded") break;
      assert.ok(
        !["failed", "refunded", "cancelled"].includes(current.status),
        JSON.stringify(current),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(current.status, "succeeded", JSON.stringify(current));
    console.log("Workload accepted", { id: current.id, mode: mode.kind });
    if (gpu) {
      const result = current.result as {
        embeddings: number[][];
        execution: { fully_gpu_resident: boolean };
      };
      assert.equal(result.embeddings.length, 33);
      assert.equal(result.execution.fully_gpu_resident, true);
    }
    results.push({ ...current, result: undefined });
  }
  const expected = BigInt(pilot.initial) + BigInt(gpu ? 33000 : 1000);
  assert.ok(recoveredPayout, "Must exercise the payout/acknowledgement crash window");
  assert.equal(BigInt(await pilot.balance()), expected);
  relay = await pilot.relay(settings.BITTERBOT_SOAPBOX_URL, token);
  await relay();
  await relay();
  assert.equal(BigInt(await pilot.balance()), expected, "Restarted settlement must not pay twice");
  await call("soapbox.worker.pause", { id: "worker", paused: true });
  for (const funded of [false, true]) {
    const job = await call<SoapboxJob>("soapbox.submit", {
      idempotency_key: randomUUID(),
      mode: { kind: "paid_usdc", operator: "worker", max_cost_microusdc: 1000 },
      workload: { kind: "sha256", texts: ["cancelled"] },
      resources: { cpu_threads: 1, memory_mib: 256, require_gpu: false },
    });
    if (funded) await pilot.fund(job.payment!);
    await call("soapbox.cancel", { id: job.id });
    await relay();
    const cancelled = await call<SoapboxJob>("soapbox.job", { id: job.id });
    assert.equal(cancelled.status, funded ? "refunded" : "cancelled");
  }
  assert.equal(BigInt(await pilot.balance()), expected);
  Object.assign(report, {
    results,
    operator_after_microusdc: await pilot.balance(),
    restart_idempotency: true,
    recovered_after_payout_before_ack: recoveredPayout,
    funded_refund: true,
    unfunded_void: true,
    completed_at: new Date().toISOString(),
  });
  delete report.current_job;
  await saveReport();
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.stop();
  await gateway?.close({ reason: "Soapbox payment pilot complete" });
  if (gateway) {
    const { stopTaskStore } = await import("../src/tasks/store.js");
    const { stopHormonalAccessor } = await import("../src/tasks/hormonal-accessor.js");
    stopHormonalAccessor();
    stopTaskStore();
  }
  await stop?.();
  await pilot.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("soapbox-payment-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
