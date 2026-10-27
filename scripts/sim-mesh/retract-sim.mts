/**
 * Publisher side: retract a skill this test node published (scripts/sim-mesh/README.md).
 *
 *   BITTERBOT_STATE_DIR=... BITTERBOT_ORCHESTRATOR_IPC_PATH=... \
 *     node --import tsx scripts/sim-mesh/retract-sim.mts <skillName> [reason]
 *
 * Uses the real `publishRetraction` (PLAN-45 3.4): the signed stub rides the
 * publish verb and the receiver drops the quarantined copy by author key and
 * content hash.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../../src/config/io.js";
import { ipcAuthLine, loadOrCreateIpcToken } from "../../src/infra/orchestrator-ipc-token.js";
import { resolveP2pKeyDir } from "../../src/infra/p2p-key-dir.js";
import { publishRetraction } from "../../src/memory/skill-evolution/p2p-publish.js";

const configDir = process.env.BITTERBOT_STATE_DIR;
const ipcPath = process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH;
const [name, reason = "simulation: retract after mesh test"] = process.argv.slice(2);
if (!configDir || !ipcPath || !name) {
  throw new Error(
    "usage: BITTERBOT_STATE_DIR=.. BITTERBOT_ORCHESTRATOR_IPC_PATH=.. retract-sim.mts <skillName> [reason]",
  );
}
const meta = JSON.parse(
  await fs.readFile(path.join(configDir, "skills", name, ".evolution-meta.json"), "utf-8"),
) as { published?: { contentHash?: string } };
const contentHash = meta.published?.contentHash;
if (!contentHash) {
  throw new Error(`${name} has no published marker; nothing to retract`);
}
const token = loadOrCreateIpcToken(resolveP2pKeyDir(loadConfig().p2p?.keyDir));
const pending = new Map<string, (v: unknown) => void>();
const sock = await new Promise<net.Socket>((res, rej) => {
  const s = net.createConnection({ path: ipcPath }, () => {
    s.write(ipcAuthLine(token));
    res(s);
  });
  s.on("error", rej);
});
readline.createInterface({ input: sock }).on("line", (line) => {
  let msg: { type: string; id?: string; payload?: unknown };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  const settle = msg.type === "response" && msg.id ? pending.get(msg.id) : undefined;
  if (settle && msg.id) {
    pending.delete(msg.id);
    settle(msg.payload);
  }
});
const publisher = {
  publishSkill: (skillMd: string, skillName: string) =>
    new Promise<unknown>((res) => {
      const id = randomUUID();
      pending.set(id, res);
      sock.write(
        `${JSON.stringify({ type: "publish_skill", id, payload: { skill_md: skillMd, name: skillName } })}\n`,
      );
    }),
};
const result = await publishRetraction({
  publisher,
  name,
  contentHash,
  reason,
  storeOpts: { configDir },
});
console.log("retraction:", JSON.stringify(result), "of", contentHash.slice(0, 12));
sock.end();
