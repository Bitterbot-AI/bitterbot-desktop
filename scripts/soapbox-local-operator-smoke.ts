import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SoapboxClient, type SoapboxJob } from "../src/infra/soapbox-client.js";
import {
  LocalOperatorService,
  prepareLocalOperator,
} from "../src/services/soapbox-local-operator.js";

assert(
  process.env.SOAPBOX_BIN && process.env.SOAPBOX_SANDBOX_CONFIG,
  "Set SOAPBOX_BIN and SOAPBOX_SANDBOX_CONFIG",
);
const root = await mkdtemp(path.join(tmpdir(), "local-operator-smoke-"));
const worker = JSON.parse(await readFile(process.env.SOAPBOX_SANDBOX_CONFIG, "utf8"));
const template = path.join(root, "template.json");
await writeFile(template, JSON.stringify({ ...worker, ollama_model: null, ollama_digest: null }), {
  mode: 0o600,
});
const directory = path.join(root, "operator");
const settings = await prepareLocalOperator(directory, {
  binary: process.env.SOAPBOX_BIN,
  worker: template,
});
const service = new LocalOperatorService(directory, process.env.SOAPBOX_BIN);
const client = new SoapboxClient(settings.url, settings.admin);
async function until(check: () => Promise<boolean>, label: string, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await service.start();
  await until(
    async () => (await client.status()).nodes?.some((n) => n.online) ?? false,
    "worker registration",
  );
  const coordinator = (service as unknown as { children: ChildProcess[] }).children[0]!;
  assert(coordinator.pid);
  coordinator.kill("SIGKILL"); // Fault injection targets only this fresh test's owned process.
  await until(async () => {
    const owned = (service as unknown as { children: ChildProcess[] }).children;
    return (
      owned.length === 2 &&
      owned[0]?.pid !== coordinator.pid &&
      Boolean((await client.status().catch(() => null))?.nodes?.some((n) => n.online))
    );
  }, "coordinator and worker restart");
  const job = await client.request<SoapboxJob>("POST", "/v1/jobs", {
    idempotency_key: randomUUID(),
    mode: { kind: "private", pool_id: "private" },
    workload: { kind: "sha256", texts: ["operator recovery"] },
    resources: { cpu_threads: 1, memory_mib: 256, require_gpu: false },
  });
  await until(async () => {
    const next = await client.request<SoapboxJob>("GET", `/v1/jobs/${job.id}`);
    assert(!["failed", "cancelled"].includes(next.status));
    return next.status === "succeeded";
  }, "isolated CPU execution after recovery");
  console.log(
    JSON.stringify({ test: "local-operator-recovery", passed: true, walletAccessed: false, root }),
  );
} finally {
  await service.stop();
}
await assert.rejects(client.status(1000));
