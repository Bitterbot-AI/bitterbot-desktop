#!/usr/bin/env node
/**
 * Write a minimal bitterbot.json for one isolated test node (scripts/sim-mesh/README.md).
 *
 *   node scripts/sim-mesh/write-config.mjs <node> <gatewayPort> <p2pPort> <httpPort> <primaryModel> [bootstrapMultiaddr]
 *
 * The node's state dir is $SIM_MESH_ROOT/<node> (default ~/bitterbot-sim/<node>);
 * start it with BITTERBOT_STATE_DIR pointing there. Dreams, consolidation,
 * curiosity and memory search are off so the node makes no LLM or embedding
 * calls; the P2P sidecar runs through the isolating wrapper next to this file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [node, gwPort, p2pPort, httpPort, model, bootstrap] = process.argv.slice(2);
if (!node || !gwPort || !p2pPort || !httpPort || !model) {
  console.error(
    "usage: write-config.mjs <node> <gatewayPort> <p2pPort> <httpPort> <primaryModel> [bootstrapMultiaddr]",
  );
  process.exit(2);
}
const root = process.env.SIM_MESH_ROOT ?? path.join(os.homedir(), "bitterbot-sim");
const dir = path.join(root, node);
fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = {
  gateway: {
    port: Number(gwPort),
    mode: "local",
    bind: "loopback",
    auth: { mode: "token", token: crypto.randomBytes(24).toString("hex") },
  },
  agents: { defaults: { model: { primary: model }, memorySearch: { enabled: false } } },
  p2p: {
    enabled: true,
    orchestratorBinary: path.join(here, "orchestrator-isolated.sh"),
    listenAddrs: [`/ip4/127.0.0.1/tcp/${p2pPort}`],
    ...(bootstrap ? { bootstrapPeers: [bootstrap] } : {}),
    keyDir: path.join(dir, "keys"),
    httpAddr: `127.0.0.1:${httpPort}`,
    nodeTier: "edge",
    relayMode: "off",
    topics: { skills: true, telemetry: false },
  },
  skills: { p2p: { ingestPolicy: "review" }, evolution: { propagate: true, maturityDays: 1 } },
  memory: {
    dream: { enabled: false },
    consolidation: { enabled: false },
    curiosity: { enabled: false },
  },
};
fs.writeFileSync(path.join(dir, "bitterbot.json"), `${JSON.stringify(cfg, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`wrote ${path.join(dir, "bitterbot.json")} (state dir ${dir})`);
