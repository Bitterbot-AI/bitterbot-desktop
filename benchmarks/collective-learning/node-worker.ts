import path from "node:path";
import { z } from "zod";
import type { BitterbotConfig } from "../../src/config/config.js";
import { readJson, DeploymentSpecSchema, validateCorpus } from "./deployment-contract.js";
import { StudyNode } from "./study-node.js";
import { CONDITIONS } from "./study.js";

const [directory, specFile, conditionText, nodeText] = process.argv.slice(2);
const condition = z.enum(CONDITIONS).parse(conditionText),
  nodeId = z.enum(["a", "b"]).parse(nodeText);
if (!process.send || path.resolve(directory) !== process.env.BITTERBOT_STATE_DIR)
  throw new Error("Study worker requires isolated state and private parent IPC");
const spec = DeploymentSpecSchema.parse(await readJson(specFile));
const corpus = validateCorpus(await readJson(path.join(path.dirname(specFile), "corpus.json")));
const config = (await readJson(path.join(directory, "bitterbot.json"))) as BitterbotConfig;
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
let counter = 0;
const accounting = (operation: string, value: unknown) =>
  new Promise<void>((resolve, reject) => {
    const id = `account:${counter++}`;
    pending.set(id, { resolve, reject });
    process.send!({ type: "accounting", id, operation, value });
  });
const worker = new StudyNode({
  directory,
  node: nodeId,
  condition,
  spec,
  config,
  corpus,
  accounting: {
    reserve: (charge) => accounting("reserve", charge),
    finish: (id, row, artifact) => accounting("finish", { id, row, artifact }),
  },
});
const abort = new AbortController();
let busy = false;
process.on("message", async (raw: unknown) => {
  const message = raw as {
    type: string;
    id: string;
    method: string;
    input: Record<string, unknown>;
    error?: string;
  };
  if (message.type === "accounted") {
    const task = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) task?.reject(new Error(message.error));
    else task?.resolve();
    return;
  }
  if (message.type !== "request") return;
  if (busy) {
    process.send!({ type: "response", id: message.id, error: "Worker already executing" });
    return;
  }
  busy = true;
  try {
    let result: unknown;
    if (message.method === "peers")
      result = await worker.configurePeers(
        message.input.peers as Parameters<StudyNode["configurePeers"]>[0],
        message.input.circleId as string | undefined,
      );
    else if (message.method === "join") {
      await worker.join(message.input.invite as string);
      result = { joined: true };
    } else if (message.method === "policy") {
      worker.setupPolicy(message.input.peers as Parameters<StudyNode["setupPolicy"]>[0]);
      result = { configured: true };
    } else if (message.method === "status")
      result = {
        currentHash: worker.currentHash(),
        circle: worker.meta("circle"),
        learningEndedAt: worker.meta("learning-ended-at"),
        finalRanAt: worker.meta("final-ran-at"),
        command:
          worker.db
            .prepare("SELECT hash,state,result FROM study_node_commands WHERE id=?")
            .get((message.input.commandId as string) ?? "") ?? null,
      };
    else if (message.method === "close") {
      await worker.close();
      process.send!({ type: "response", id: message.id, result: { closed: true } }, () =>
        process.exit(0),
      );
      return;
    } else
      result = await worker.commandRun(message.id, message.method, message.input, abort.signal);
    process.send!({ type: "response", id: message.id, result });
  } catch (error) {
    process.send!({ type: "response", id: message.id, error: String(error) });
  } finally {
    busy = false;
  }
});
process.on("disconnect", () => {
  abort.abort();
  setTimeout(() => process.exit(1), 1000).unref();
});
process.on("SIGTERM", () => {
  abort.abort();
  setTimeout(() => process.exit(1), 1000).unref();
});
try {
  process.send({ type: "ready", descriptor: await worker.start() });
} catch (error) {
  process.send!({ type: "failed", error: String(error) });
  process.exitCode = 1;
  await worker.close();
  process.disconnect!();
}
