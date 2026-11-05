import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, PROPOSER, runEpisode, ADAPTER_REVISION } from "./episode.mjs";
import { createProvider, model, rates, hash, priorExposure } from "./provider.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9_-]+$/.test(id))
  throw Error(
    "Usage: node --import tsx benchmarks/learning-strategy/telecom/run.mjs unique-pilot-id",
  );
const resultsRoot = path.join(here, "../results");
const lockPath = path.join(resultsRoot, ".collector.lock");
const lock = fs.openSync(lockPath, "wx");
fs.writeSync(lock, JSON.stringify({ pid: process.pid, id }));
process.once("exit", () => {
  fs.closeSync(lock);
  fs.unlinkSync(lockPath);
});
const root = path.join(resultsRoot, id);
fs.mkdirSync(root);
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { flag: "wx" });
const event = (value) =>
  fs.appendFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({ ...value, at: new Date().toISOString() }) + "\n",
  );
const prior = priorExposure(resultsRoot);
const exposure = prior.reduce((sum, row) => sum + row.usd, 0),
  remaining = 10 - exposure;
if (remaining <= 0) throw Error("Shared $10 budget exhausted");
write("project-budget.json", { ceiling: 10, priorExposure: prior, remaining });
const qualification = JSON.parse(fs.readFileSync(path.join(here, "qualification-v1.json")));
if (
  qualification.rows.length !== 41 ||
  qualification.rows.some(
    (r) =>
      !r.reference.passed ||
      r.referenceErrors.length ||
      r.noop.passed ||
      r.omitFirst.passed ||
      !r.unrelatedTamperRejected,
  )
)
  throw Error("Native qualification failed");
const protocol = {
  schemaVersion: 1,
  kind: "telecom-headroom-pilot",
  adapterRevision: ADAPTER_REVISION,
  observationMode: "structured",
  model,
  rates,
  indices: [0, 14, 21, 45],
  maxCalls: 96,
  perEpisodeUsd: 1.25,
  cumulativeCeilingUsd: 10,
  initialActor: ACTOR,
  initialProposer: PROPOSER,
  pricingSource: "https://platform.claude.com/docs/en/about-claude/pricing",
  pricingChecked: "2026-11-02",
  endpoint:
    "All native environment assertions pass, replay reproduces live state, and unrelated server accounts/lines/bills/plans/devices are preserved.",
  selection:
    "Four cases chosen before model calls: simple mobile data, seven-repair mobile data, service restoration, nine-repair MMS. This is a deliberate qualification sample, not representative accuracy.",
  headroomGate:
    "At least one verified success and one verified failure with natural completion; no output truncation, empty response, call limit or budget limit. Manually classify whether failures belong to actor or simulator before any learning study.",
  scope:
    "Native tools, data and assertions; custom role-separated text simulator and Anthropic provider. No official tau-bench score, native runner, voice/persona binding parity or live-user claim.",
  transfer:
    "No learning or transfer during this pilot. Pilot cases are development-only and excluded from a future final test.",
};
write("protocol.json", protocol);
const files = [
  "native.py",
  "bridge.mjs",
  "episode.mjs",
  "grounding.mjs",
  "diagnostic-observations.mjs",
  "public-observations.mjs",
  "provider.mjs",
  "run.mjs",
  "requirements.txt",
  "native-sources.json",
  "qualification-v1.json",
].map((f) => path.join(here, f));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "native-sources.json")));
files.push(...manifest.files.map((f) => path.join(here, "vendor", f.path)));
files.push(
  path.join(
    here,
    "../datasets/tau-bench-v2-en/upstream/data/tau2/multilingual/en/telecom_tasks_en.json",
  ),
);
for (const name of [
  "learning-strategy.ts",
  "learning-strategy-archive.ts",
  "learning-strategy-contract.ts",
  "procedural-learning.ts",
  "procedural-learning-store.ts",
  "procedural-learning-contract.ts",
])
  files.push(path.resolve("src/memory", name));
fs.mkdirSync(path.join(root, "source"));
const sources = files.map((file, i) => {
  const body = fs.readFileSync(file),
    snapshot = `source/${i}-${path.basename(file)}`;
  fs.writeFileSync(path.join(root, snapshot), body);
  return {
    file: path.relative(process.cwd(), file).replaceAll("\\", "/"),
    snapshot,
    sha256: hash(body.toString("utf8")),
  };
});
write("freeze.json", {
  at: new Date().toISOString(),
  protocolHash: hash(protocol),
  node: process.version,
  sources,
});
const provider = createProvider(root, remaining);
const budget = { providerUsd: 10, toolCalls: 10000, wallMs: 100000000 };
const db = new DatabaseSync(path.join(root, "pilot.sqlite"));
const service = new ProceduralLearning(
  new ProceduralLearningStore(db, { mode: "shadow", maxEntries: 100, executionBudget: budget }),
);
const scope = {
  tool: "tau2-telecom-native",
  version: manifest.commit,
  operation: "customer-support",
  contractHash: learningHash({ native: manifest, adapterRevision: ADAPTER_REVISION }),
};
const strategy = service.strategies.archive.add({
  schemaVersion: 1,
  scope,
  actor: ACTOR,
  proposer: PROPOSER,
  parents: [],
  sharing: "private",
  expiresAt: Date.now() + 7 * 86400000,
});
const episodes = [];
service.strategies.registerPanel({
  id: `${id}-development`,
  scope,
  partition: "development",
  model,
  verifierHash: hash(fs.readFileSync(path.join(here, "native.py"), "utf8")),
  isolation: "sandbox",
  sharing: "private",
  cases: protocol.indices.map((index, i) => ({ id: `pilot-${i + 1}`, input: { index } })),
  quote: () => ({ providerUsd: protocol.perEpisodeUsd, toolCalls: 1000, wallMs: 1800000 }),
  execute: async (candidate, input, signal) => {
    console.log(JSON.stringify({ event: "episode-start", index: input.index }));
    const result = await runEpisode({
      index: input.index,
      strategy: candidate.actor,
      provider,
      tag: `pilot-${input.index}`,
      signal,
      maxCalls: protocol.maxCalls,
      maxUsd: protocol.perEpisodeUsd,
      onEvent: (e) => event({ ...e, index: input.index }),
    });
    write(`episode-${input.index}.json`, result);
    episodes.push({ index: input.index, ...result });
    console.log(
      JSON.stringify({
        event: "episode-complete",
        index: input.index,
        verdict: result.verdict,
        reason: result.reason,
        cost: result.cost,
      }),
    );
    return { output: result, cost: result.cost };
  },
  verify: async (_input, result) => ({
    passed: result.verdict.passed,
    feedback: JSON.stringify({ passed: result.verdict.passed, termination: result.reason }),
    cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
  }),
});
try {
  const evaluation = await service.strategies.evaluate(strategy, `${id}-development`, budget);
  const interfaceValid = episodes.every(
    (e) => ["user-ended", "human-transfer"].includes(e.reason) && e.verdict.replayMatch,
  );
  const eligible =
    interfaceValid && evaluation.successes > 0 && evaluation.successes < evaluation.total;
  write("complete.json", {
    evaluation,
    provider: provider.status(),
    headroomGate: eligible,
    interfaceValid,
    priorExposureUsd: exposure,
    cumulativeExposureUsd: exposure + provider.status().spent,
    note: eligible
      ? "Inspect attribution of failures before authorizing the learning comparison."
      : "No qualified accuracy headroom established; do not evolve on this pilot.",
  });
  console.log(
    JSON.stringify({
      event: "complete",
      evaluation,
      headroomGate: eligible,
      provider: provider.status(),
    }),
  );
} catch (error) {
  write("incomplete.json", { error: error.message, provider: provider.status() });
  throw error;
} finally {
  await service.close();
}
