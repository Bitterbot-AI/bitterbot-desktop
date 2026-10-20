/** Fresh release profile; never reads or writes the user's wallets or running app config. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const release = path.resolve(process.argv[2]);
const { install } = await import(pathToFileURL(path.join(release, "setup/install.mjs")));
const root = await mkdtemp(path.join(tmpdir(), "soapbox-rc5-operator-"));
const home = path.join(root, "home"),
  state = path.join(home, ".bitterbot");
const app = path.join(state, "app/current");
const base = path.join(homedir(), ".bitterbot/app/current");
await mkdir(path.join(app, "dist"), { recursive: true });
for (const name of ["package.json", "bitterbot.mjs"])
  await cp(path.join(base, name), path.join(app, name));
for (const name of ["node_modules", "extensions", "skills"])
  await symlink(path.join(base, name), path.join(app, name), "dir");
for (const name of await readdir(path.join(base, "dist"))) {
  if (["entry.js", "babel.cjs"].includes(name))
    await cp(path.join(base, "dist", name), path.join(app, "dist", name));
  else await symlink(path.join(base, "dist", name), path.join(app, "dist", name));
}
// Use the same host GPU reservation while isolating all wallet/profile paths.
await mkdir(path.join(home, ".bitterbot-soapbox"), { recursive: true });
await symlink(
  path.join(homedir(), ".bitterbot-soapbox/gpu.lock"),
  path.join(home, ".bitterbot-soapbox/gpu.lock"),
);
await mkdir(path.join(state, "p2p-keys"), { recursive: true });
await writeFile(path.join(state, "p2p-keys/node.key"), randomBytes(32), { mode: 0o600 });
const token = randomBytes(32).toString("hex");
const config = {
  gateway: {
    mode: "local",
    port: 19281,
    bind: "loopback",
    auth: { mode: "token", token },
    controlUi: { enabled: true },
  },
  agents: { defaults: { workspace: path.join(root, "workspace") } },
  p2p: {
    enabled: true,
    bootstrapPeers: [],
    bootstrapDns: "",
    relayMode: "off",
    listenAddrs: ["/ip4/127.0.0.1/tcp/29281"],
    httpAddr: "127.0.0.1:29282",
    keyDir: path.join(state, "p2p-keys"),
  },
  tools: {
    wallet: { enabled: false, network: "base", walletStorePath: path.join(state, "wallet") },
  },
};
await mkdir(path.join(state, "wallet"), { recursive: true });
await writeFile(
  path.join(state, "wallet/untouched-fixture.json"),
  JSON.stringify({ fixture: "not-a-real-wallet" }),
);
const configFile = path.join(state, "bitterbot.json");
await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
const before = createHash("sha256")
  .update(await readFile(path.join(state, "wallet/untouched-fixture.json")))
  .digest("hex");
const installed = await install({ release, state, role: "operator", apply: true });
assert(installed.installed);
const metadata = {
  root,
  state,
  home,
  app,
  target: installed.target,
  configFile,
  port: 19281,
  pid: process.pid,
  beforeWalletHash: before,
};
await writeFile(path.join(root, "test-profile.json"), JSON.stringify(metadata), { mode: 0o600 });
await writeFile(
  path.join(process.cwd(), "reports/compute-rc5/live-profile.json"),
  JSON.stringify(metadata),
  { mode: 0o600 },
);
const launch = () => {
  const child = spawn(
    process.execPath,
    [path.join(app, "dist/entry.js"), "gateway", "run", "--port", "19281", "--bind", "loopback"],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LANG: "C.UTF-8",
        BITTERBOT_STATE_DIR: state,
        BITTERBOT_CONFIG_PATH: configFile,
        BITTERBOT_ORCHESTRATOR_IPC_PATH: path.join(root, "p2p.sock"),
        BITTERBOT_SKIP_CHANNELS: "1",
        BITTERBOT_SKIP_PROVIDERS: "1",
        BITTERBOT_NO_RESPAWN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = createWriteStream(path.join(root, "gateway.log"), { flags: "a", mode: 0o600 });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("close", () => log.end());
  return child;
};
let child = launch(),
  stopping = false;
const monitor = (current) =>
  current.once("exit", (code) => {
    if (!stopping && (code === 0 || code === 75)) {
      child = launch();
      monitor(child);
    }
  });
monitor(child);
process.on("SIGTERM", () => {
  stopping = true;
  child.kill("SIGTERM");
});
process.on("SIGINT", () => {
  stopping = true;
  child.kill("SIGTERM");
});
console.log(
  JSON.stringify({ test: "fresh-operator-release", root, url: "http://127.0.0.1:19281/" }),
);
