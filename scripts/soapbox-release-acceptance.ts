/** Acceptance test for two desktop profiles on ONE host; never claims cross-machine validation. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { GatewayClient } from "../src/gateway/client.js";
import type { SoapboxJob, SoapboxStatus } from "../src/infra/soapbox-client.js";

const home = homedir();
console.log("Checking Base Sepolia and connecting the two desktop profiles");
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const operatorState = path.join(home, ".bitterbot-soapbox-release-test");
const operatorId = "release-operator";
const mainFile = path.join(home, ".bitterbot/bitterbot.json");
const main = await json(mainFile);
const mainWallet = JSON.stringify(main.tools?.wallet);
const walletFile = path.join(home, ".bitterbot/wallet/wallet-data.json");
const walletHash = createHash("sha256")
  .update(await readFile(walletFile))
  .digest("hex");
const connection = await json(path.join(operatorState, "operator.json"));
const rpc = createPublicClient({
  chain: baseSepolia,
  transport: http("https://base-sepolia-rpc.publicnode.com", { timeout: 10000, retryCount: 1 }),
});
assert.equal(await rpc.getChainId(), 84532);
const balance = () =>
  rpc.readContract({
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [connection.address],
  });
const sockets: GatewayClient[] = [];
const connect = (port: number, token: string) =>
  new Promise<GatewayClient>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway ${port} did not connect`)), 30000);
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.admin"],
      tickWatchMinIntervalMs: 180000,
      onHelloOk: () => {
        clearTimeout(timer);
        resolve(client);
      },
      onConnectError: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    sockets.push(client);
    client.start();
  });
try {
  const buyer = await connect(19001, main.gateway.auth.token);
  console.log("Buyer desktop connected");
  const operator = await connect(
    19041,
    (await json(path.join(operatorState, "bitterbot.json"))).gateway.auth.token,
  );
  console.log("Operator desktop connected; checking access controls");
  assert.equal(
    (await operator.request<SoapboxStatus>("soapbox.status", {})).principal?.id,
    operatorId,
  );
  for (const method of ["soapbox.wallet", "soapbox.payment.fund", "soapbox.submit"])
    await assert.rejects(operator.request(method, { id: "not-a-job" }));
  await assert.rejects(operator.request("soapbox.worker.pause", { id: "worker", paused: true }));
  let runtime;
  console.log("Waiting for isolated GPU operator readiness");
  for (let n = 0; n < 120; n++) {
    const s = await buyer.request<SoapboxStatus>("soapbox.status", {});
    const node = s.nodes?.find(
      (w) => w.id === operatorId && w.online && !w.offer.paused && w.offer.gpu_observed,
    );
    if (node?.offer.runtime) {
      runtime = node.offer.runtime;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.ok(runtime, "Enrolled GPU operator must be ready");
  const before = await balance();
  const job = await buyer.request<SoapboxJob>("soapbox.submit", {
    idempotency_key: randomUUID(),
    mode: { kind: "paid_usdc", operator: operatorId, max_cost_microusdc: 2000 },
    workload: {
      kind: "embeddings",
      model: runtime.model,
      model_digest: runtime.model_digest,
      texts: [
        "Installable buyer and operator test release",
        "Base Sepolia GPU payment through two desktop profiles",
      ],
    },
    resources: { cpu_threads: 1, memory_mib: 1024, require_gpu: true },
  });
  assert.equal(job.status, "awaiting_payment");
  assert.equal(job.payment?.operator.toLowerCase(), connection.address.toLowerCase());
  await assert.rejects(operator.request("soapbox.job", { id: job.id }));
  console.log("Funding release acceptance job", { id: job.id, amount_microusdc: 2000 });
  const funding = await buyer.request("soapbox.payment.fund", { id: job.id });
  let done = job;
  for (let n = 0; n < 180; n++) {
    done = await buyer.request<SoapboxJob>("soapbox.job", { id: job.id });
    if (done.status === "succeeded") break;
    assert.ok(
      !["failed", "cancelled", "refunded"].includes(done.status),
      `Job ended ${done.status}`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.equal(done.status, "succeeded");
  const result = done.result as {
    embeddings: number[][];
    execution: { fully_gpu_resident: boolean };
  };
  assert.equal(result.embeddings.length, 2);
  assert.equal(result.embeddings[0].length, 384);
  assert.equal(result.execution.fully_gpu_resident, true);
  const operatorJob = await operator.request<SoapboxJob>("soapbox.job", { id: job.id });
  assert.deepEqual(operatorJob.receipt, done.receipt);
  assert.equal((done.receipt as { worker: string }).worker, operatorId);
  const after = await balance();
  assert.equal(after - before, 2000n);
  const own = await operator.request<SoapboxJob[]>("soapbox.jobs", {});
  assert.ok(own.some((j) => j.id === job.id));
  await buyer.request("soapbox.payment.refresh", { id: job.id });
  await buyer.request("soapbox.payment.refresh", { id: job.id });
  assert.equal(await balance(), after);
  assert.equal(JSON.stringify((await json(mainFile)).tools?.wallet), mainWallet);
  assert.equal(
    createHash("sha256")
      .update(await readFile(walletFile))
      .digest("hex"),
    walletHash,
  );
  const evidence = {
    version: "0.3.0-rc.1",
    topology: "two desktop gateway profiles on one physical host",
    physical_two_machine_test: false,
    chain_id: 84532,
    job: { ...done, result: undefined },
    funding,
    operator_before_microusdc: String(before),
    operator_after_microusdc: String(after),
    vectors: 2,
    dimensions: 384,
    operator_wallet_access_rejected: true,
    operator_cross_worker_pause_rejected: true,
    unassigned_job_access_rejected: true,
    repeat_payment_refresh_no_duplicate_payout: true,
    main_wallet_configuration_and_identity_unchanged: true,
    completed_at: new Date().toISOString(),
  };
  const output =
    process.env.SOAPBOX_RELEASE_REPORT ??
    path.resolve(import.meta.dirname, "../docs/network/soapbox-release-validation.json");
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify(
      { job: job.id, operator: operatorId, paid_microusdc: 2000, evidence: output },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.stop();
}
