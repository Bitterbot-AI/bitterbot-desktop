import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { runEpisode } from "./episode.mjs";
import { evidenceSchedule } from "./evidence-protocol.mjs";
import { prerequisiteProvider } from "./prerequisite-ledger.mjs";
import {
  SOURCE,
  FRESH,
  ACTORS,
  ACTOR,
  PROPOSER,
  ADAPTER_REVISION,
  DECISION,
  AUTHORIZATION,
  checkFreeze,
  freezeSources,
  consumedCases,
} from "./prerequisite-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./provider.mjs";
const results = "benchmarks/learning-strategy/results";
const [mode, id, stage, gateId] = process.argv.slice(2);
assert.ok(["prepare", "run"].includes(mode) && /^[\w-]+$/.test(id ?? ""));
const root = path.join(results, id),
  read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const budgetFor = (n) => ({ providerUsd: n * 3, toolCalls: n * 1000, wallMs: n * 1800000 });
const serviceAt = (dir, name, budget) =>
  new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(dir, name + ".sqlite")), {
      mode: "shadow",
      maxEntries: 100,
      executionBudget: budget,
    }),
  );
if (mode === "prepare") {
  assert.ok(["source", "fresh"].includes(stage));
  const qualification = JSON.parse(
    fs.readFileSync(".tmp/prerequisite-offline-qualification.json", "utf8"),
  );
  const coldPreflight = JSON.parse(
    fs.readFileSync(".tmp/prerequisite-audit-preflight.json", "utf8"),
  );
  assert.equal(qualification.status, "passed");
  assert.equal(coldPreflight.status, "passed");
  const baseRoot = path.join(results, "telecom-evidence-comparison-v1"),
    baseFreeze = checkFreeze(baseRoot),
    consumed = consumedCases(results, id);
  let gate = null,
    profile = SOURCE;
  if (stage === "fresh") {
    assert.ok(/^[\w-]+$/.test(gateId ?? ""));
    const g = path.join(results, gateId);
    checkFreeze(g);
    const gr = (n) => JSON.parse(fs.readFileSync(path.join(g, n), "utf8"));
    assert.equal(gr("protocol.json").stage, "source");
    assert.equal(gr("audit.json").status, "passed");
    const a = gr("prerequisite-analysis.json");
    assert.equal(a.advancementGate.passed, true);
    assert.ok(FRESH.indices.every((i) => !consumed.includes(i)));
    profile = { ...FRESH, arms: ["baseline", a.advancementGate.selected] };
    gate = { run: gateId, selected: a.advancementGate.selected, analysisHash: hash(a) };
  }
  const native = JSON.parse(
    fs.readFileSync("benchmarks/learning-strategy/telecom/native-sources.json", "utf8"),
  );
  const scope = {
    tool: "tau2-telecom-native",
    version: native.commit,
    operation: "customer-support",
    contractHash: hash({
      native,
      adapterRevision: ADAPTER_REVISION,
      hostIntervention: "prerequisite-ledger-v1",
    }),
  };
  const baseline = {
    schemaVersion: 1,
    scope,
    actor: ACTOR,
    proposer: PROPOSER,
    parents: [],
    sharing: "shareable",
    expiresAt: Date.now() + 7 * 86400000,
  };
  const protocol = {
    kind: "telecom-prerequisite-comparison",
    stage,
    ...profile,
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    model,
    rates,
    scope,
    baseline,
    actors: ACTORS,
    hostIntervention: { baseline: "none", explicit: "none", ledger: "prerequisite-ledger-v1" },
    schedule: evidenceSchedule(profile),
    consumedCases: consumed,
    gate,
    maxCalls: 128,
    perEpisodeUsd: 3,
    conversationCache: true,
    newSpendCircuitBreakerUsd: profile.concurrency * profile.laneCeilingUsd,
    authorization: AUTHORIZATION,
    decision: DECISION,
    discoveryAllocationUsd: 0,
    design:
      "Host-authored execution mechanism; no autonomous proposal or transfer. Same explicit instructions for explicit and ledger arms; only ledger appends fresh actor-visible facts to each actor request. No hidden state, automatic repair, handoff veto or customer-interface change. Original native v8 runtime. Consumed MMS source cases plus domestic/already-enabled controls 0 and 2. Three unseeded repetitions; rotated blocks and isolated per-arm/repetition stores. Fresh selection fixed by source gate. All outcomes and costs retained.",
    endpoints:
      "Native repair plus natural completion, interface/resource failures, model/tool calls, usage, uncached equivalent, descriptive case-cluster intervals, ledger delivery/unknown-state frequency and post-collection mutation counts. No comprehensive consent claim or production activation.",
  };
  const code = [
    "prerequisite-account.mjs",
    "prerequisite-ledger.mjs",
    "prerequisite-ledger.test.mjs",
    "prerequisite-protocol.mjs",
    "prerequisite-study.mjs",
    "prerequisite-audit.mjs",
    "prerequisite-analyze.mjs",
    "prerequisite-qualify.mjs",
    "procedure-protocol.mjs",
  ].map((n) => "benchmarks/learning-strategy/telecom/" + n);
  const extras = gate
    ? ["protocol.json", "audit.json", "prerequisite-analysis.json"].map((n) =>
        path.join(results, gate.run, n),
      )
    : [];
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  write("offline-qualification.json", qualification);
  write("audit-preflight.json", coldPreflight);
  freezeSources(root, protocol, [
    ...baseFreeze.sources.map((s) => s.file),
    ...code,
    ...extras,
    path.join(root, "offline-qualification.json"),
    path.join(root, "audit-preflight.json"),
  ]);
  write("preflight.json", {
    status: "ready",
    stage,
    episodes: profile.indices.length * profile.arms.length * profile.repetitions,
    priorExposureUsd: priorExposure(results).reduce((s, r) => s + r.usd, 0),
    newSpendCircuitBreakerUsd: protocol.newSpendCircuitBreakerUsd,
  });
  console.log(JSON.stringify(read("preflight.json")));
} else {
  checkFreeze(root);
  const protocol = read("protocol.json");
  if (protocol.stage !== "source")
    assert.ok(
      protocol.indices.every((i) => !consumedCases(results, id).includes(i)),
      "Case consumed after preparation",
    );
  const lockPath = path.join(results, ".collector.lock"),
    lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  const providers = Array.from({ length: protocol.concurrency }, () =>
    createProvider(root, protocol.laneCeilingUsd),
  );
  const status = () => {
    const lanes = providers.map((p) => p.status());
    return {
      spent: lanes.reduce((s, r) => s + r.spent, 0),
      reserved: lanes.reduce((s, r) => s + r.reserved, 0),
      unresolved: lanes.reduce((s, r) => s + r.unresolved, 0),
      lanes,
    };
  };
  const evaluations = [],
    executions = [];
  let nextBlock = 0,
    fatal = null;
  try {
    const prior = priorExposure(results),
      exposure = prior.reduce((s, r) => s + r.usd, 0);
    write("project-budget.json", {
      priorExposure: prior,
      ceiling: exposure + protocol.newSpendCircuitBreakerUsd,
      authorization: AUTHORIZATION,
    });
    const worker = async (lane) => {
      while (!fatal && nextBlock < protocol.schedule.length) {
        const blockIndex = nextBlock++,
          block = protocol.schedule[blockIndex],
          budget = budgetFor(block.indices.length);
        fs.appendFileSync(
          path.join(root, "lanes.jsonl"),
          JSON.stringify({ lane, blockIndex, store: block.store }) + "\n",
        );
        const service = serviceAt(root, block.store, budget);
        try {
          const lab = service.strategies;
          let target;
          const parent = lab.archive.add(protocol.baseline);
          target =
            block.arm === "baseline"
              ? parent
              : lab.archive.add({ ...protocol.baseline, actor: protocol.actors[block.arm] });
          lab.registerPanel({
            id: block.store,
            scope: protocol.scope,
            partition: protocol.partition,
            sharing: "shareable",
            model,
            verifierHash: hash(
              fs.readFileSync("benchmarks/learning-strategy/telecom/native.py", "utf8"),
            ),
            isolation: "sandbox",
            cases: block.indices.map((index) => ({ id: `case-${index}`, input: { index } })),
            quote: () => ({ providerUsd: 3, toolCalls: 1000, wallMs: 1800000 }),
            execute: async (candidate, input, signal) => {
              if (fatal) throw Error("Stage stopped after lane failure");
              const label = `${block.arm}-${block.repetition}-${input.index}`;
              console.log(JSON.stringify({ event: "episode-start", label, lane }));
              const episode = await runEpisode({
                index: input.index,
                strategy: candidate.actor,
                tag: label,
                signal,
                maxCalls: 128,
                maxUsd: 3,
                conversationCache: true,
                observationMode: "structured",
                provider: prerequisiteProvider(
                  {
                    call: async (...args) => {
                      if (fatal) throw Error("Stage stopped");
                      return providers[lane].call(...args);
                    },
                  },
                  block.arm,
                  (event) =>
                    fs.appendFileSync(
                      path.join(root, "ledger-events.jsonl"),
                      JSON.stringify(event) + "\n",
                    ),
                ),
                onEvent: (e) =>
                  fs.appendFileSync(
                    path.join(root, "events.jsonl"),
                    JSON.stringify({ ...e, label, lane, at: new Date().toISOString() }) + "\n",
                  ),
              });
              write(`episode-${label}.json`, episode);
              executions.push({
                label,
                index: input.index,
                arm: block.arm,
                repetition: block.repetition,
                strategy: candidate.actor,
              });
              console.log(
                JSON.stringify({
                  event: "episode-complete",
                  label,
                  passed: episode.verdict.passed,
                  reason: episode.reason,
                  cost: episode.cost,
                }),
              );
              return { output: episode, cost: episode.cost };
            },
            verify: async (_input, e) => ({
              passed: e.verdict.passed && ["user-ended", "human-transfer"].includes(e.reason),
              feedback:
                protocol.partition === "development"
                  ? JSON.stringify({ passed: e.verdict.passed, termination: e.reason })
                  : "held-out",
              cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
            }),
          });
          if (protocol.partition === "held-out") lab.archive.seal(protocol.scope, [target]);
          const result = await lab.evaluate(target, block.store, budget);
          if (protocol.partition === "development") lab.archive.seal(protocol.scope, [target]);
          evaluations.push({ ...block, blockIndex, result });
        } catch (error) {
          fatal ??= error;
          throw error;
        } finally {
          await service.close();
        }
      }
    };
    const settled = await Promise.allSettled(providers.map((_p, i) => worker(i)));
    const expected = protocol.schedule.flatMap((b) =>
      b.indices.map((i) => `${b.arm}-${b.repetition}-${i}`),
    );
    executions.sort((a, b) => expected.indexOf(a.label) - expected.indexOf(b.label));
    evaluations.sort((a, b) => a.blockIndex - b.blockIndex);
    const result = {
      evaluations,
      executionManifest: executions,
      provider: status(),
      priorExposureUsd: exposure,
      cumulativeExposureUsd: exposure + status().spent,
      collectionStatus:
        executions.length === expected.length &&
        executions.every((e) =>
          ["user-ended", "human-transfer"].includes(read(`episode-${e.label}.json`).reason),
        )
          ? "complete"
          : "censored",
    };
    if (settled.some((r) => r.status === "rejected")) {
      write("incomplete.json", { ...result, error: fatal?.message });
      throw fatal;
    }
    write("complete.json", result);
    console.log(
      JSON.stringify({ event: "complete", episodes: executions.length, provider: status() }),
    );
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
