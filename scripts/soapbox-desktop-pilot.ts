/** Persistent, loopback-only Compute UI with separate Base Sepolia wallet state. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";

const root = path.resolve(import.meta.dirname, "..");
const repo = process.env.SOAPBOX_REPO ?? path.resolve(root, "../soapbox");
const directory =
  process.env.SOAPBOX_PILOT_STATE ?? path.join(homedir(), ".bitterbot-soapbox-pilot");
const binary = process.env.SOAPBOX_BINARY ?? path.join(repo, ".local/bin/soapbox-linux");
const port = 19031;
const servicesOnly = process.argv.includes("--services-only");
const appUrl = `http://127.0.0.1:${servicesOnly ? 19001 : port}`;
const coordinator = "http://127.0.0.1:8787";
assert.equal(process.platform, "linux", "Run this pilot in Linux/WSL");
await mkdir(directory, { recursive: true, mode: 0o700 });
const release = await lockfile.lock(directory, { retries: 0 });
await writeFile(path.join(directory, "launcher.pid"), String(process.pid), { mode: 0o600 });
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const save = (file: string, data: unknown) =>
  writeFile(path.join(directory, file), JSON.stringify(data, null, 2), { mode: 0o600 });
const live = await json(path.join(homedir(), ".bitterbot/bitterbot.json"));
process.env.CDP_API_KEY_ID ??= live.tools?.wallet?.cdpApiKeyId;
process.env.CDP_API_KEY_SECRET ??= live.tools?.wallet?.cdpApiKeySecret;
assert.ok(
  process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.CDP_WALLET_SECRET,
  "The existing CDP environment is required; never put keys in this script",
);
const evidence = await json(path.join(repo, "docs/evidence/phase2-base-sepolia.json"));
const payments = {
  ...evidence.chain,
  rpc_url: process.env.SOAPBOX_PILOT_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com",
};
assert.equal(payments.chain_id, 84532);
const accounts = await json(path.join(repo, ".local/testnet-accounts.json"));
assert.equal(accounts.buyer.toLowerCase(), payments.wallets.buyer.toLowerCase());
assert.equal(accounts.operator.toLowerCase(), payments.wallets.worker.toLowerCase());
let credentials: { gateway: string; buyer: string; worker: string };
try {
  credentials = await json(path.join(directory, "credentials.json"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  credentials = Object.fromEntries(
    ["gateway", "buyer", "worker"].map((key) => [key, randomBytes(32).toString("hex")]),
  ) as typeof credentials;
  await save("credentials.json", credentials);
}
for (const value of Object.values(credentials)) assert.match(value, /^[a-f0-9]{64}$/);
const admissions: {
  id: string;
  role: "buyer" | "operator";
  address: string;
  token: string;
  pools: string[];
  projects: string[];
}[] = await json(path.join(directory, "admissions.json")).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return [];
});
const ids = new Set(["buyer", "worker"]);
const tokens = new Set([credentials.buyer, credentials.worker]);
for (const entry of admissions) {
  assert.match(entry.id, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.ok(!ids.has(entry.id) && !tokens.has(entry.token), "Duplicate enrollment identity");
  assert.ok(["buyer", "operator"].includes(entry.role));
  assert.match(entry.token, /^[a-f0-9]{64}$/);
  assert.match(entry.address, /^0x[\da-f]{40}$/i);
  ids.add(entry.id);
  tokens.add(entry.token);
  payments.wallets[entry.id] = entry.address;
}
const worker = await json(path.join(repo, ".local/worker-isolated.json"));
assert.ok(worker.sandbox && !worker.allow_unsafe_host, "An isolated worker is required");
await save("worker.json", {
  ...worker,
  pools: ["circle"],
  projects: ["science"],
  pause_file: path.join(directory, "PAUSE"),
});
await save("coordinator.json", {
  payments,
  principals: [
    ...admissions.map((entry, i) => ({
      id: entry.id,
      token_env: `SOAPBOX_ENROLLED_${i}`,
      roles: [entry.role === "buyer" ? "submitter" : "worker"],
      pools: entry.pools,
      projects: entry.projects,
    })),
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
});
Object.assign(process.env, {
  BITTERBOT_HOME: directory,
  BITTERBOT_STATE_DIR: path.join(directory, "gateway"),
  BITTERBOT_CONFIG_PATH: path.join(directory, "gateway.json"),
  BITTERBOT_GATEWAY_PORT: String(port),
  BITTERBOT_GATEWAY_TOKEN: credentials.gateway,
  BITTERBOT_TASKS_DB: path.join(directory, "tasks.sqlite"),
  BITTERBOT_TASKS_COMPLETION_NOTIFY: "0",
  BITTERBOT_TASKS_HORMONAL_GATE: "0",
  BITTERBOT_EVENT_JOURNAL: "0",
  BITTERBOT_CHECKPOINTS: "0",
  VITEST: "1",
  BITTERBOT_TEST_MINIMAL_GATEWAY: "1",
  BITTERBOT_SOAPBOX_ENABLED: "1",
  BITTERBOT_SOAPBOX_URL: coordinator,
  BITTERBOT_SOAPBOX_TOKEN: credentials.buyer,
  BITTERBOT_SOAPBOX_ESCROW: payments.escrow,
  BITTERBOT_SOAPBOX_ESCROW_CODE_SHA256: payments.escrow_code_sha256,
  BITTERBOT_SOAPBOX_RPC_URL: payments.rpc_url,
  RPC_URL: payments.rpc_url,
  NETWORK_ID: "base-sepolia",
});
// This process owns its services; the gateway must not launch duplicate children.
delete process.env.BITTERBOT_SOAPBOX_CONFIG;
delete process.env.BITTERBOT_SOAPBOX_WORKER_CONFIG;
await save("gateway.json", {
  tools: {
    wallet: {
      enabled: true,
      network: "base-sepolia",
      walletStorePath: path.join(directory, "wallet"),
      perTransactionCapUsd: 0.1,
      dailySpendLimitUsd: 1,
    },
  },
  gateway: {
    mode: "local",
    port,
    auth: { mode: "token", token: credentials.gateway },
    controlUi: { enabled: true, root: path.join(root, "desktop/dist-renderer") },
  },
  agents: {
    defaults: { workspace: path.join(directory, "workspace"), memorySearch: { enabled: false } },
  },
});
await save("process.json", {
  pid: process.pid,
  url: appUrl,
  state: "starting",
  started_at: new Date().toISOString(),
});

let stopping = false;
const children = new Set<ChildProcess>();
const timers = new Set<ReturnType<typeof setTimeout>>();
const childEnv = {
  PATH: process.env.PATH,
  HOME: homedir(),
  BITTERBOT_SOAPBOX_TOKEN: credentials.buyer,
  SOAPBOX_WORKER_TOKEN: credentials.worker,
  ...Object.fromEntries(admissions.map((entry, i) => [`SOAPBOX_ENROLLED_${i}`, entry.token])),
};
function supervise(
  name: string,
  args: string[],
  command = binary,
  env: NodeJS.ProcessEnv = childEnv,
) {
  if (stopping) return;
  const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] });
  children.add(child);
  child.on("error", (error) => console.error(`${name}: ${error.message}`));
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`${name} exited (${code ?? signal}); restarting in 5 seconds`);
    const timer = setTimeout(() => {
      timers.delete(timer);
      supervise(name, args, command, env);
    }, 5000);
    timers.add(timer);
  });
}
let relayTask: Promise<void> | undefined;
let stopResolve: () => void;
const stopped = new Promise<void>((resolve) => {
  stopResolve = resolve;
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true;
    stopResolve();
  });
try {
  console.log("Loading the testnet wallet SDK and settlement verifier...");
  const { CdpClient } = await import("@coinbase/cdp-sdk");
  const cdp = new CdpClient({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    walletSecret: process.env.CDP_WALLET_SECRET,
  });
  const { createRelay } = (await import(
    pathToFileURL(path.join(repo, "settlement/relay.mjs")).href
  )) as {
    createRelay: (options: {
      config: typeof payments;
      url: string;
      token: string;
      signer: string;
      sendTransaction: (tx: {
        to: `0x${string}`;
        data: `0x${string}`;
        value: bigint;
      }) => Promise<string>;
      onTransaction: (record: unknown) => void;
    }) => Promise<() => Promise<void>>;
  };
  const relayOptions = {
    config: payments,
    url: coordinator,
    token: credentials.buyer,
    signer: accounts.settler,
    sendTransaction: async (transaction: {
      to: `0x${string}`;
      data: `0x${string}`;
      value: bigint;
    }) =>
      (
        await cdp.evm.sendTransaction({
          address: accounts.settler,
          network: "base-sepolia",
          transaction,
        })
      ).transactionHash,
    onTransaction: (record: unknown) =>
      console.log("Settlement transaction", JSON.stringify(record)),
  };
  let tick: (() => Promise<void>) | undefined;
  for (let attempt = 0; attempt < 5 && !stopping; attempt++) {
    try {
      tick = await createRelay(relayOptions);
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      console.error("Escrow verification unavailable; retrying in 10 seconds.");
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 10000))]);
    }
  }
  assert.ok(tick, "Escrow verification did not finish");
  console.log("Base Sepolia escrow verified; starting isolated compute services.");
  supervise("coordinator", [
    "serve",
    "--config",
    path.join(directory, "coordinator.json"),
    "--db",
    path.join(directory, "state.sqlite"),
    "--bind",
    "127.0.0.1:8787",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 40 && !stopping; attempt++) {
    try {
      const response = await fetch(`${coordinator}/v1/status`, {
        headers: { Authorization: `Bearer ${credentials.buyer}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for the owned coordinator to bind. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, "Coordinator did not become ready (check port 8787)");
  relayTask = (async () => {
    while (!stopping) {
      try {
        await tick!();
      } catch (error) {
        console.error("Settlement retry:", error instanceof Error ? error.message : String(error));
      }
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  })();
  // Use the production bundle so the wallet sidebar does not cold-load AgentKit's
  // unrelated integrations over WSL's slow mounted filesystem.
  if (!servicesOnly)
    supervise(
      "gateway",
      [
        path.join(root, "dist/entry.js"),
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
      ],
      process.execPath,
      process.env,
    );
  let uiReady = servicesOnly;
  for (let attempt = 0; !uiReady && attempt < 300 && !stopping; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        uiReady = true;
        break;
      }
    } catch {
      /* Wait for the built gateway and renderer. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(uiReady || stopping, "Desktop gateway did not become ready; inspect pilot.log");
  if (!stopping) {
    if (process.env.SOAPBOX_LOCAL_WORKER !== "0")
      supervise("worker", [
        "worker",
        "--config",
        path.join(directory, "worker.json"),
        "--coordinator",
        coordinator,
      ]);
    await save("process.json", {
      pid: process.pid,
      url: appUrl,
      services_only: servicesOnly,
      state: "ready",
      chain_id: 84532,
      buyer: accounts.buyer,
      operator: accounts.operator,
    });
    console.log(`Soapbox desktop ready: ${appUrl} — Compute`);
  }
  await stopped;
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  stopping = true;
  stopResolve!();
  for (const timer of timers) clearTimeout(timer);
  for (const child of children) child.kill("SIGTERM");
  await Promise.race([
    Promise.all(
      [...children].map((child) => new Promise((resolve) => child.once("exit", resolve))),
    ),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([relayTask, new Promise((resolve) => setTimeout(resolve, 5000))]);
  await save("process.json", {
    pid: process.pid,
    state: "stopped",
    url: appUrl,
  });
  await release();
  process.exit(process.exitCode ?? 0);
}
