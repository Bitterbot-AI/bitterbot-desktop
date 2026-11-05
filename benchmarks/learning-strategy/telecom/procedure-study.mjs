import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportStrategyPacket,
  importStrategyPacket,
} from "../../../src/memory/learning-strategy-peer.ts";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, ADAPTER_REVISION, runEpisode } from "./episode.mjs";
import { evidenceSchedule } from "./evidence-protocol.mjs";
import {
  STAGES,
  CHECKLIST,
  AUTHORIZATION,
  checkFreeze,
  freezeSources,
  consumedCases,
} from "./procedure-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./provider.mjs";

const results = "benchmarks/learning-strategy/results";
const [mode, id, stage, discoveryId, gateId] = process.argv.slice(2);
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
  assert.ok(STAGES[stage] && /^[\w-]+$/.test(discoveryId ?? ""));
  const discoveryRoot = path.join(results, discoveryId),
    discoveryFreeze = checkFreeze(discoveryRoot);
  const dr = (n) => JSON.parse(fs.readFileSync(path.join(discoveryRoot, n), "utf8"));
  assert.equal(dr("audit.json").status, "passed");
  const baseline = dr("baseline.json"),
    candidate = dr("candidate.json"),
    candidateHash = learningHash(candidate);
  assert.equal(candidateHash, dr("audit.json").candidateHash);
  assert.equal(baseline.actor, ACTOR);
  assert.ok(candidate.actor.startsWith(ACTOR + "\n\n"));
  const profile = STAGES[stage],
    consumed = consumedCases(results, id);
  if (stage !== "source")
    assert.ok(
      profile.indices.every((i) => !consumed.includes(i)),
      "Fresh case already consumed",
    );
  let gate = null,
    envelope = null;
  if (stage !== "source") {
    assert.ok(/^[\w-]+$/.test(gateId ?? ""));
    const gateRoot = path.join(results, gateId);
    checkFreeze(gateRoot);
    const gp = JSON.parse(fs.readFileSync(path.join(gateRoot, "protocol.json"), "utf8"));
    const ga = JSON.parse(fs.readFileSync(path.join(gateRoot, "procedure-analysis.json"), "utf8"));
    assert.equal(gp.stage, stage === "fresh" ? "source" : "fresh");
    assert.equal(gp.candidateHash, candidateHash);
    assert.equal(ga.advancementGate.passed, true);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(gateRoot, "audit.json"), "utf8")).status,
      "passed",
    );
    gate = { run: gateId, analysisHash: hash(ga) };
    if (stage === "recipient") {
      const sourceRoot = path.join(results, gp.gate.run),
        source = serviceAt(sourceRoot, "learned-0", budgetFor(4));
      try {
        const content = exportStrategyPacket(source.strategies, candidateHash, "learned-0"),
          bytes = Buffer.from(content),
          keys = generateKeyPairSync("ed25519");
        envelope = {
          version: 1,
          name: "telecom-learned-procedure-shadow",
          skill_md: bytes.toString("base64"),
          content_hash: hash(content),
          author_peer_id: "isolated-procedure-source",
          author_pubkey: keys.publicKey
            .export({ type: "spki", format: "der" })
            .subarray(-32)
            .toString("base64"),
          timestamp: Date.now(),
          signature: sign(null, bytes, keys.privateKey).toString("base64"),
        };
      } finally {
        await source.close();
      }
    }
  }
  const protocol = {
    kind: "telecom-procedure-comparison",
    stage,
    ...profile,
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    model,
    rates,
    discoveryId,
    candidateHash,
    scope: baseline.scope,
    baseline,
    candidate,
    actors: { baseline: ACTOR, checklist: ACTOR + "\n\n" + CHECKLIST, learned: candidate.actor },
    schedule: evidenceSchedule(profile),
    consumedCases: consumed,
    gate,
    envelope,
    maxCalls: 128,
    perEpisodeUsd: 3,
    conversationCache: true,
    newSpendCircuitBreakerUsd: profile.concurrency * profile.laneCeilingUsd,
    authorization: AUTHORIZATION,
    design:
      "One machine-generated append, frozen unchanged across all stages. Manual checklist fixed before generation. Isolated store per arm/repetition, fresh native process per episode, rotated block order and independent provider lanes. Same actor/customer model and observation boundary. Source cases are consumed development; fresh and recipient cases are disjoint prospectively reserved combinations. Unseeded draws; case clusters are the comparison units.",
    endpoints:
      "Native repair AND natural termination; all assigned failures count. Also interface/resource failures, model/tool calls, receipts and uncached equivalent. Inspect mutation counts and failed trajectories separately; no claim of comprehensive consent grading. Learned-minus-controls descriptive case-cluster bootstrap. No within-stage tuning, retries, reselection or production activation.",
    gateDecision: dr("protocol.json").decision,
    discoveryAllocationUsd:
      dr("complete.json").discoveryAllocationUsd ?? dr("complete.json").provider.spent,
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  const extra = ["baseline.json", "candidate.json", "complete.json", "audit.json"].map((n) =>
    path.join(discoveryRoot, n),
  );
  if (gate)
    extra.push(
      ...["protocol.json", "procedure-analysis.json", "audit.json"].map((n) =>
        path.join(results, gate.run, n),
      ),
    );
  freezeSources(root, protocol, [...discoveryFreeze.sources.map((s) => s.file), ...extra]);
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
          if (protocol.stage === "recipient" && block.arm === "learned") {
            assert.equal(
              service.store.db.prepare("SELECT count(*) n FROM learning_runs").get().n,
              0,
            );
            target = importStrategyPacket(lab, protocol.envelope);
            assert.equal(target, protocol.candidateHash);
            assert.equal(
              service.store.db.prepare("SELECT count(*) n FROM learning_runs").get().n,
              0,
            );
          } else {
            const parent = lab.archive.add(protocol.baseline);
            target =
              block.arm === "baseline"
                ? parent
                : block.arm === "learned"
                  ? lab.archive.add(protocol.candidate)
                  : lab.archive.add({ ...protocol.baseline, actor: protocol.actors.checklist });
          }
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
                provider: {
                  call: async (...args) => {
                    if (fatal) throw Error("Stage stopped");
                    return providers[lane].call(...args);
                  },
                },
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
