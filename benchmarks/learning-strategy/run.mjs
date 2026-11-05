import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportStrategyPacket,
  importStrategyPacket,
} from "../../src/memory/learning-strategy-peer.ts";
import { learningHash } from "../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../src/memory/procedural-learning.ts";
import { createProvider, model, rates } from "./provider.mjs";
import {
  act,
  judge,
  hash,
  makeTasks,
  publicTask,
  diagnosticControl,
  hypotheses,
  apply,
  reference,
  queryPool,
  parseJson,
} from "./world.mjs";

export const ACTOR =
  "Track the hypotheses still consistent with observed outputs. Choose probes that distinguish those hypotheses, paying attention to rounding and operation order. Recompute each candidate carefully; do not assume a contract from its version or ID. Use the three-query allowance when needed and submit a hypothesis consistent with all observations.";
export const PROPOSER =
  "Improve the actor using measured execution feedback. Identify specific reasoning or experiment-selection mistakes, propose a small reusable correction, and preserve behavior that already works. Avoid embedding task-specific IDs, answers or examples. Use actual tool observations, not guesses about the hidden implementation. Improve the instructions used by future proposers when the evidence supports a better analysis method.";
const scope = {
  tool: "contract-discovery-lab",
  version: "1",
  operation: "diagnose",
  contractHash: learningHash("finite-probe-interface-v1"),
};
const budget = { providerUsd: 10, toolCalls: 10000, wallMs: 100000000 };
const files = [
  "benchmarks/learning-strategy/run.mjs",
  "benchmarks/learning-strategy/provider.mjs",
  "benchmarks/learning-strategy/world.mjs",
  "benchmarks/learning-strategy/analyze.mjs",
  "src/memory/learning-strategy.ts",
  "src/memory/learning-strategy-archive.ts",
  "src/memory/learning-strategy-contract.ts",
  "src/memory/learning-strategy-peer.ts",
  "src/memory/procedural-learning.ts",
  "src/memory/procedural-learning-store.ts",
  "src/memory/procedural-learning-contract.ts",
  "src/agents/skills/envelope-validation.ts",
];
const protocol = {
  schemaVersion: 1,
  model,
  rates,
  initialActor: ACTOR,
  initialProposer: PROPOSER,
  ceilingUsd: 10,
  sourceSeeds: [17011, 27011],
  sourceGenerations: 3,
  developmentCases: 3,
  heldOutCases: 6,
  baselineControl:
    "Freeze and evaluate the initial actor alongside the selected actor on the same final panel. If selection retains the initial strategy, reuse that one evaluation.",
  arms: ["fixed-incumbent", "fixed-population", "evolving-incumbent", "evolving-population"],
  transferGenerations: 1,
  transferSourceSeed: 17011,
  transferDomains: [
    { domain: "sequence", version: 1 },
    { domain: "numeric", version: 2 },
  ],
  endpoint:
    "Verified complete behavior on a separate fixed input suite. Selection uses development success, then lower observed provider cost. No test feedback enters evolution.",
  analysis:
    "Exploratory 2x2 ablation. Two independent search seeds are the replication unit; task-level wins/losses are descriptive. No powered significance, production promotion, 24-hour retention or real-user claim.",
  accounting:
    "Shared source discovery is physically paid once and allocated in full to each transfer deployment. Source populations retain losers; incumbent controls branch from the current best. All provider calls, invalid proposals and failures are charged.",
  limitations:
    "Synthetic finite hypothesis discovery with unusually reliable host oracles. A deterministic information-gain control has the same public hypotheses and probes. Twelve isolated SQLite stores model source and recipient roles using signed in-process envelopes, not a public/native mesh test.",
  ordering:
    "Four source arms run concurrently with at most three total provider calls. Each store is serial. Recipient comparisons use independent stores. Provider latency is descriptive, not a deployment benchmark.",
  pilotGate:
    "Run the source search only if a separately seeded strong initial actor has at least one verified failure among six numeric tasks and at least two successes. Pilot outcomes excluded from main estimates.",
  partitionAmendment:
    "Before main collection, reserve disjoint deployed hypothesis IDs for development and final tasks within each search seed. Pilot v3 used independently seeded task IDs but did not enforce this semantic split. Main panels use a seeded hypothesis permutation; no main outcome informed this amendment.",
};
const phase = process.argv[2] ?? "pilot",
  id = process.argv[3] ?? `${phase}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (!["pilot", "study"].includes(phase) || !/^[A-Za-z0-9_-]+$/.test(id))
  throw Error("Usage: run.mjs pilot|study unique-id [pilot-directory]");
const root = path.resolve("benchmarks/learning-strategy/results", id);
const resultsRoot = path.dirname(root),
  lockPath = path.join(resultsRoot, ".collector.lock");
const lock = fs.openSync(lockPath, "wx");
fs.writeSync(lock, JSON.stringify({ pid: process.pid, id }));
process.once("exit", () => {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
});
fs.mkdirSync(root, { recursive: false });
fs.mkdirSync(path.join(root, "source"));
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { flag: "wx" });
const append = (value) =>
  fs.appendFileSync(path.join(root, "events.jsonl"), JSON.stringify(value) + "\n");
const sources = files.map((file, i) => {
  const body = fs.readFileSync(file);
  const snapshot = `source/${i}-${path.basename(file)}`;
  fs.writeFileSync(path.join(root, snapshot), body);
  return { file, snapshot, sha256: createHash("sha256").update(body).digest("hex") };
});
write("protocol.json", protocol);
write("freeze.json", {
  at: new Date().toISOString(),
  phase,
  id,
  protocolHash: hash(protocol),
  node: process.version,
  sources,
});
const priorExposure = [];
for (const directory of fs
  .readdirSync(resultsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())) {
  const file = path.join(resultsRoot, directory.name, "provider.jsonl");
  if (!fs.existsSync(file)) continue;
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const receipts = new Map(
    rows.filter((row) => row.type === "receipt").map((row) => [row.id, row]),
  );
  for (const intent of rows.filter((row) => row.type === "intent"))
    priorExposure.push({
      run: directory.name,
      id: intent.id,
      usd: receipts.get(intent.id)?.usd ?? intent.quote,
      unresolved: !receipts.has(intent.id),
    });
}
const remaining = protocol.ceilingUsd - priorExposure.reduce((sum, item) => sum + item.usd, 0);
write("project-budget.json", { ceiling: protocol.ceilingUsd, priorExposure, remaining });
const provider = createProvider(root, remaining),
  services = [];
const expiresAt = Date.now() + 7 * 86400000;
function node(name) {
  const service = new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(root, `${name}.sqlite`)), {
      mode: "shadow",
      maxEntries: 200,
      executionBudget: budget,
    }),
  );
  services.push(service);
  return service;
}
function seed(lab, actor = ACTOR, proposer = PROPOSER, parents = []) {
  return lab.archive.add({
    schemaVersion: 1,
    scope,
    actor,
    proposer,
    parents,
    sharing: "shareable",
    expiresAt,
  });
}
function panel(lab, name, tasks, partition) {
  lab.registerPanel({
    id: name,
    scope,
    partition,
    model,
    isolation: "sandbox",
    sharing: "shareable",
    verifierHash: hash(fs.readFileSync("benchmarks/learning-strategy/world.mjs", "utf8")),
    cases: tasks.map((input) => ({ id: input.id, input })),
    quote: () => ({ providerUsd: 0.5, toolCalls: 4, wallMs: 400000 }),
    execute: async (strategy, input, signal) => act(provider, strategy, input, signal),
    verify: async (input, output) => {
      const passed = judge(input, output.id);
      append({ kind: "trial", node: name, task: input.id, partition, passed, output });
      return {
        passed,
        cost: { providerUsd: 0, toolCalls: 1, wallMs: 0 },
        feedback: JSON.stringify({
          task: publicTask(input),
          observed: output.history,
          submitted: output.id,
          passed,
          invalid: output.invalid,
        }),
      };
    },
  });
}
async function evaluate(lab, candidate, panelId) {
  const result = await lab.evaluate(candidate, panelId, budget);
  append({ kind: "evaluation", ...result });
  console.log(
    JSON.stringify({ panel: panelId, score: result.score, cost: result.cost.providerUsd }),
  );
  return result;
}
async function evolve(lab, name, initial, { evolving, population, generations }) {
  let hash = initial;
  await evaluate(lab, hash, `${name}-dev`);
  for (let generation = 0; generation < generations; generation++) {
    const ranked = lab.archive.rank(`${name}-dev`);
    // Half of steps exploit; other steps deterministically explore a non-best branch.
    const index =
      population && generation % 2 === 1 && ranked.length > 1
        ? 1 + (generation % (ranked.length - 1))
        : 0;
    const parent = ranked[index].strategy;
    try {
      hash = await lab.propose({
        parent,
        panel: `${name}-dev`,
        evolveProposer: evolving,
        fixedProposer: PROPOSER,
        quote: { providerUsd: 0.3, toolCalls: 0, wallMs: 200000 },
        budget,
        generate: async (context, signal) => {
          const prompt = `You propose bounded agent and learning-strategy edits.\nCurrent improvement instructions:\n${context.instructions}\nCurrent actor:\n${context.parent.actor}\nCurrent proposer:\n${context.parent.proposer}\nMeasured development feedback:\n${context.feedback.join("\n")}\nReturn ONLY JSON with exactly two strings: {"actor":"complete operational instructions for the next task agent", "proposer":"complete analysis and proposal instructions for future improvements"}. Each is at most 4000 characters. Produce reusable strategies, not task answers. You cannot change the task interface, probe allowance, verifier or permissions.`;
          const receipt = await provider.call(prompt, {
            maxTokens: 1800,
            schema: {
              type: "object",
              properties: { actor: { type: "string" }, proposer: { type: "string" } },
              required: ["actor", "proposer"],
              additionalProperties: false,
            },
            tag: `proposal:${name}:${generation}`,
            signal,
          });
          let edit;
          try {
            edit = parseJson(receipt.text);
          } catch {
            edit = null;
          }
          append({ kind: "proposal", node: name, generation, parent, request: receipt.id, edit });
          return { edit, cost: { providerUsd: receipt.usd, toolCalls: 0, wallMs: receipt.wallMs } };
        },
      });
    } catch (error) {
      if (error.name !== "ZodError") throw error;
      append({ kind: "invalid-proposal", node: name, generation, error: error.message });
      continue;
    }
    await evaluate(lab, hash, `${name}-dev`);
  }
  const selected = lab.archive.rank(`${name}-dev`)[0];
  lab.archive.seal(scope, [...new Set([selected.strategy, initial])]);
  const tested = await evaluate(lab, selected.strategy, `${name}-test`);
  const baseline =
    selected.strategy === initial ? tested : await evaluate(lab, initial, `${name}-test`);
  return {
    name,
    selected,
    tested,
    baseline,
    costs: lab.store.costs(),
    strategy: lab.archive.get(selected.strategy),
  };
}
function signed(content) {
  const bytes = Buffer.from(content),
    keys = generateKeyPairSync("ed25519");
  return {
    version: 1,
    name: "shadow-strategy",
    skill_md: bytes.toString("base64"),
    content_hash: createHash("sha256").update(bytes).digest("hex"),
    author_peer_id: "isolated-source",
    author_pubkey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64"),
    timestamp: Date.now(),
    signature: sign(null, bytes, keys.privateKey).toString("base64"),
  };
}
try {
  let qualified = 0;
  for (const domain of ["numeric", "sequence"])
    for (const version of [1, 2])
      for (const h of hypotheses(domain, version))
        for (const input of domain === "numeric"
          ? Array.from({ length: 201 }, (_, i) => i - 100)
          : queryPool(domain)) {
          if (
            JSON.stringify(apply(domain, h, input)) !== JSON.stringify(reference(domain, h, input))
          )
            throw Error("Oracle qualification failed");
          qualified++;
        }
  write("qualification.json", { referenceChecks: qualified });
  if (phase === "pilot") {
    const results = [];
    for (const domain of ["numeric", "sequence"]) {
      const name = `pilot-${domain}`,
        lab = node(name).strategies,
        tasks = makeTasks(domain, 97011, "pilot", 6);
      write(`${name}-panel.json`, tasks);
      panel(lab, name, tasks, "development");
      results.push({
        domain,
        ...(await evaluate(lab, seed(lab), name)),
        diagnosticControl: tasks.map(diagnosticControl),
      });
    }
    write("complete.json", {
      phase,
      results,
      provider: provider.status(),
      sourceGate: results[0].successes >= 2 && results[0].successes < 6,
    });
  } else {
    const pilotPath = process.argv[4];
    if (
      !pilotPath ||
      !JSON.parse(fs.readFileSync(path.join(pilotPath, "complete.json"), "utf8")).sourceGate
    )
      throw Error("Independent pilot failed source headroom gate");
    const results = [],
      labs = new Map();
    for (const runSeed of protocol.sourceSeeds) {
      const dev = makeTasks("numeric", runSeed, "development", protocol.developmentCases),
        test = makeTasks("numeric", runSeed, "held-out", protocol.heldOutCases);
      write(`source-${runSeed}-panel.json`, {
        dev,
        test,
        diagnosticControl: test.map(diagnosticControl),
      });
      const promises = protocol.arms.map(async (arm) => {
        const name = `source-${runSeed}-${arm}`,
          lab = node(name).strategies;
        labs.set(name, lab);
        panel(lab, `${name}-dev`, dev, "development");
        panel(lab, `${name}-test`, test, "held-out");
        return await evolve(lab, name, seed(lab), {
          evolving: arm.startsWith("evolving"),
          population: arm.endsWith("population"),
          generations: protocol.sourceGenerations,
        });
      });
      const settled = await Promise.allSettled(promises);
      for (const item of settled) {
        if (item.status === "rejected") throw item.reason;
        results.push(item.value);
      }
    }
    const sourceName = `source-${protocol.transferSourceSeed}-evolving-population`,
      source = results.find((r) => r.name === sourceName);
    const envelope = signed(
      exportStrategyPacket(labs.get(sourceName), source.selected.strategy, `${sourceName}-dev`),
    );
    write("transfer-envelope.json", envelope);
    for (const target of protocol.transferDomains) {
      const dev = makeTasks(target.domain, 37011, "recipient-development", 4, target.version),
        test = makeTasks(target.domain, 37011, "recipient-held-out", 6, target.version);
      write(`recipient-${target.domain}-${target.version}-panel.json`, {
        dev,
        test,
        diagnosticControl: test.map(diagnosticControl),
      });
      for (const arm of ["fresh-proposer", "transferred-proposer"]) {
        const name = `recipient-${target.domain}-${target.version}-${arm}`,
          lab = node(name).strategies;
        panel(lab, `${name}-dev`, dev, "development");
        panel(lab, `${name}-test`, test, "held-out");
        let proposer = PROPOSER,
          parents = [];
        if (arm === "transferred-proposer") {
          const imported = importStrategyPacket(lab, envelope);
          if (lab.archive.rank(`${name}-dev`).length) throw Error("Remote qualification leaked");
          proposer = lab.archive.get(imported).proposer;
          parents = [imported];
        }
        // Reset task agent and use the transferred strategy only. Both recipient proposers stay fixed during this test.
        const rootHash = seed(lab, ACTOR, proposer, parents);
        const result = await evolve(lab, name, rootHash, {
          evolving: true,
          population: false,
          generations: protocol.transferGenerations,
        });
        results.push({
          ...result,
          sourceDiscoveryAllocationUsd:
            arm === "transferred-proposer" ? source.costs.providerUsd : 0,
        });
      }
    }
    write("complete.json", { phase, results, provider: provider.status() });
  }
} catch (error) {
  write("interrupted.json", { message: error.message, provider: provider.status() });
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await Promise.allSettled(services.map((service) => service.close()));
}
console.log(JSON.stringify({ root, provider: provider.status() }));
