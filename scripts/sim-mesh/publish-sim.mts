/**
 * Publisher side of the local two-node mesh test (scripts/sim-mesh/README.md).
 *
 *   BITTERBOT_STATE_DIR=~/bitterbot-sim/a BITTERBOT_ORCHESTRATOR_IPC_PATH=/tmp/bitterbot-orchestrator-sim-a.sock \
 *     node --import tsx scripts/sim-mesh/publish-sim.mts <tag>
 *
 * Seeds two skills exactly as the evolution loop leaves them (SKILL.md,
 * `.evolution-meta.json` with an accepted gate verdict, credited reads in the
 * skill-wiki ledger), then runs the REAL housekeeping pass against the node's
 * state dir: evidence record, applicability profile, signed provenance trailer
 * and the orchestrator `publish_skill` verb over the node's own IPC socket.
 * No LLM is involved. The "good" skill was measured on the receiver's model
 * with eight passing runs; the "poor" one on a weaker model, declares another
 * OS and a binary nobody has, and carries two thin runs.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { WIKI_SUBDIR } from "../../src/agents/skills/impact-trail.js";
import { keyPairFromPrivateKeyPem } from "../../src/commerce/envelope.js";
import { loadConfig } from "../../src/config/io.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { ipcAuthLine, loadOrCreateIpcToken } from "../../src/infra/orchestrator-ipc-token.js";
import { resolveP2pKeyDir } from "../../src/infra/p2p-key-dir.js";
import { runHousekeeping } from "../../src/memory/skill-evolution/housekeeping.js";

const configDir = process.env.BITTERBOT_STATE_DIR;
const ipcPath = process.env.BITTERBOT_ORCHESTRATOR_IPC_PATH;
if (!configDir || !ipcPath) {
  throw new Error("set BITTERBOT_STATE_DIR and BITTERBOT_ORCHESTRATOR_IPC_PATH to the test node's");
}
const TAG = process.argv[2] ?? "mesh1";
const GOOD_MODEL = process.env.SIM_MESH_GOOD_MODEL ?? "anthropic/claude-opus-4-8";
const POOR_MODEL = process.env.SIM_MESH_POOR_MODEL ?? "anthropic/claude-haiku-4-5";
const now = Date.now();
const DAY = 86_400_000;

type Pending = { res: (v: unknown) => void; rej: (e: Error) => void; t: NodeJS.Timeout };
type Ipc = { send: (type: string, payload: unknown) => Promise<unknown>; close: () => void };

/** The same JSON-line protocol the gateway's orchestrator bridge speaks. */
function connectIpc(socketPath: string, token: string): Promise<Ipc> {
  return new Promise((resolve, reject) => {
    const pending = new Map<string, Pending>();
    const sock = net.createConnection({ path: socketPath }, () => {
      sock.write(ipcAuthLine(token));
      resolve({
        send: (type, payload) =>
          new Promise((res, rej) => {
            const id = randomUUID();
            const t = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${type} timed out`));
            }, 20_000);
            pending.set(id, { res, rej, t });
            sock.write(`${JSON.stringify({ type, id, payload })}\n`);
          }),
        close: () => sock.end(),
      });
    });
    sock.on("error", reject);
    readline.createInterface({ input: sock }).on("line", (line) => {
      let msg: { type: string; id?: string; payload?: unknown };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      const p = msg.type === "response" && msg.id ? pending.get(msg.id) : undefined;
      if (p && msg.id) {
        clearTimeout(p.t);
        pending.delete(msg.id);
        p.res(msg.payload);
      }
    });
  });
}

const seeds = [
  { name: `sim-mesh-good-${TAG}`, model: GOOD_MODEL, bins: ["node"], os: null, runs: 8, fails: 0 },
  {
    name: `sim-mesh-poor-${TAG}`,
    model: POOR_MODEL,
    bins: ["definitely-missing-bin-xyz"],
    os: ["darwin"],
    runs: 2,
    fails: 1,
  },
] as const;

const liveRoot = path.join(configDir, "skills");
const wikiDir = path.join(configDir, WIKI_SUBDIR);
await fs.mkdir(wikiDir, { recursive: true });
let readLines = "";
for (const s of seeds) {
  const dir = path.join(liveRoot, s.name);
  await fs.mkdir(dir, { recursive: true });
  const skillMd = [
    "---",
    `name: ${s.name}`,
    `description: Use when the task asks to ${s.name} against a flaky host; not for local files.`,
    "bitterbot:",
    "  requires:",
    `    bins: [${s.bins.join(", ")}]`,
    ...(s.os ? [`  os: [${s.os.join(", ")}]`] : []),
    "---",
    "",
    `Mesh simulation skill (${TAG}). Steps: check the host answers, retry twice with backoff, report the final status. It does nothing real.`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "SKILL.md"), skillMd);
  const meta = {
    origin: "wiki-evolution",
    stagedAt: now - 5 * DAY,
    validation: {
      mode: "tasks",
      verdict: "accepted",
      validatedAt: now - 4 * DAY,
      model: s.model,
      evolverModel: s.model,
      validatedOn: [s.model],
      trials: 9,
      meanDelta: 0.2,
      ci95Low: 0.03,
      corpusVersion: "canonical-g5-s1",
    },
  };
  await fs.writeFile(path.join(dir, ".evolution-meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  for (let i = 0; i < s.runs; i++) {
    const fail = i < s.fails;
    readLines += `${JSON.stringify({
      runId: `run-${s.name}-${i}`,
      skill: s.name,
      ts: now - (i + 1) * 6 * 3_600_000,
      success: !fail,
      label: fail ? "fail" : "pass",
      outcomeLevel: 3,
      model: s.model,
      completedExplicitly: !fail,
      toolErrors: fail ? 1 : 0,
      origin: "human",
      sessionKey: null,
      credited: true,
    })}\n`;
  }
}
await fs.appendFile(path.join(wikiDir, "skill-reads.jsonl"), readLines);
console.log(`seeded ${seeds.length} evolved skills under ${liveRoot}`);

const cfg = loadConfig();
const ipc = await connectIpc(ipcPath, loadOrCreateIpcToken(resolveP2pKeyDir(cfg.p2p?.keyDir)));
const identity = (await ipc.send("get_identity", {})) as { pubkey: string; peer_id: string };
console.log("publisher identity:", identity);
const attestKeyPair = keyPairFromPrivateKeyPem(loadOrCreateDeviceIdentity().privateKeyPem);
const primary =
  (cfg.agents?.defaults?.model as { primary?: string } | undefined)?.primary ?? "unknown";

const result = await runHousekeeping(
  {
    journal: null,
    llmCall: null,
    publisher: {
      publishSkill: async (skillMd, name) => {
        const r = await ipc.send("publish_skill", { skill_md: skillMd, name });
        console.log("orchestrator publish_skill ->", JSON.stringify(r).slice(0, 300));
        return r;
      },
    },
    attestKeyPair,
    nodePubkey: identity.pubkey,
    propagate: true,
    maturityDays: 1,
    applicabilityProfile: { enabled: true, publish: true },
    modelTag: primary,
    runtimeModelTag: primary,
    semanticLintCadenceDays: 0,
  },
  { configDir },
);
console.log(
  "housekeeping:",
  JSON.stringify({
    publish: result.publish,
    applicabilityProfiles: result.applicabilityProfiles,
    evidenceRecords: result.evidenceRecords,
  }),
);
for (const s of seeds) {
  const dir = path.join(liveRoot, s.name);
  const profile = JSON.parse(await fs.readFile(path.join(dir, ".applicability.json"), "utf-8"));
  const meta = JSON.parse(await fs.readFile(path.join(dir, ".evolution-meta.json"), "utf-8"));
  console.log(
    s.name,
    JSON.stringify({
      measured: profile.measured,
      declared: profile.declared,
      outcomes: profile.outcomes,
      published: meta.published ?? null,
    }),
  );
}
ipc.close();
