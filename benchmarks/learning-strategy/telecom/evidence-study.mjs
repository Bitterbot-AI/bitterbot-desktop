import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { LearningStrategySchema } from "../../../src/memory/learning-strategy-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { ACTOR, PROPOSER, ADAPTER_REVISION, runEpisode } from "./episode.mjs";
import { EVIDENCE_PROFILES, evidenceSchedule } from "./evidence-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./provider.mjs";
import { STRUCTURED_REMINDER_FACTS } from "./reminders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  resultsRoot = path.join(here, "../results");
const [mode, id, profileName, gateId] = process.argv.slice(2);
assert.ok(
  ["prepare", "run"].includes(mode) && /^[a-zA-Z0-9_-]+$/.test(id ?? ""),
  "Usage: evidence-study.mjs prepare unique-id compliance|comparison [passed-gate-id], or run unique-id",
);
const root = path.join(resultsRoot, id);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function consumedCases() {
  const cases = new Set();
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === id) continue;
    const dir = path.join(resultsRoot, entry.name),
      protocolFile = path.join(dir, "protocol.json");
    if (
      !fs.existsSync(protocolFile) ||
      !JSON.parse(fs.readFileSync(protocolFile, "utf8")).kind?.startsWith("telecom-")
    )
      continue;
    const ledger = path.join(dir, "provider.jsonl");
    if (fs.existsSync(ledger))
      for (const row of fs
        .readFileSync(ledger, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)) {
        const match = row.type === "intent" && row.tag?.split(":")[0].match(/-(\d+)$/);
        if (match) cases.add(Number(match[1]));
      }
  }
  return [...cases].sort((a, b) => a - b);
}
if (mode === "prepare") {
  const profile = EVIDENCE_PROFILES[profileName];
  assert.ok(profile, "Unknown stage");
  const consumed = consumedCases();
  assert.ok(
    profile.indices.every((i) => !consumed.includes(i)),
    "Case already consumed",
  );
  const qualificationPath =
    "benchmarks/learning-strategy/telecom/qualification-public-observations-v6.json";
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, "utf8"));
  assert.equal(qualification.status, "passed");
  assert.equal(qualification.adapterRevision, ADAPTER_REVISION);
  assert.equal(qualification.rulesHash, hash(MISSING_DIAGNOSTIC_REMINDERS));
  for (const source of qualification.sources)
    assert.equal(
      hash(fs.readFileSync(source.file, "utf8")),
      source.sha256,
      `Stale qualification: ${source.file}`,
    );
  let gate = null;
  if (profileName === "comparison") {
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(gateId ?? ""), "Passed gate run required");
    const gateRoot = path.join(resultsRoot, gateId);
    const gateProtocol = JSON.parse(fs.readFileSync(path.join(gateRoot, "protocol.json"), "utf8"));
    const gateAudit = JSON.parse(fs.readFileSync(path.join(gateRoot, "audit.json"), "utf8"));
    const gateAnalysis = JSON.parse(
      fs.readFileSync(path.join(gateRoot, "evidence-analysis.json"), "utf8"),
    );
    assert.equal(gateProtocol.adapterRevision, ADAPTER_REVISION);
    assert.equal(gateProtocol.stage, "interface-qualification");
    assert.equal(gateAudit.status, "passed");
    assert.equal(gateAnalysis.interfaceGate.passed, true);
    const gateFreeze = JSON.parse(fs.readFileSync(path.join(gateRoot, "freeze.json"), "utf8"));
    for (const source of gateFreeze.sources)
      assert.equal(
        hash(fs.readFileSync(source.file, "utf8")),
        source.sha256,
        `Changed since interface gate: ${source.file}`,
      );
    gate = { run: gateId, analysisHash: hash(gateAnalysis), auditHash: hash(gateAudit) };
  }
  const native = JSON.parse(fs.readFileSync(path.join(here, "qualification-v1.json"), "utf8"));
  assert.ok(
    profile.indices.every((i) => native.rows.some((r) => r.index === i && r.reference.passed)),
  );
  const staticActor =
    ACTOR +
    "\n\nConditional troubleshooting reminders:\n" +
    MISSING_DIAGNOSTIC_REMINDERS.map((r) => `When ${JSON.stringify(r.when)}: ${r.text}`).join("\n");
  LearningStrategySchema.shape.actor.parse(staticActor);
  const protocol = {
    schemaVersion: 1,
    kind: "telecom-conditional-reminder-comparison",
    purpose: profile.stage,
    profileName,
    ...profile,
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    model,
    rates,
    consumedCases: consumed,
    schedule: evidenceSchedule(profile),
    initialActor: ACTOR,
    initialProposer: PROPOSER,
    staticActor,
    reminders: MISSING_DIAGNOSTIC_REMINDERS,
    reminderFacts: STRUCTURED_REMINDER_FACTS,
    maxCalls: 128,
    perEpisodeUsd: 3,
    conversationCache: true,
    gate,
    newSpendCircuitBreakerUsd: profile.concurrency * profile.laneCeilingUsd,
    authorization:
      "User: Don't worry about the budget and proceed thoroughly. We need some good data. This supersedes the earlier $15 cumulative limit for this research. Finite lane circuit breakers are engineering limits chosen for this frozen stage, not a user-specified budget.",
    design:
      "Independent sealed SQLite per arm/repetition; fresh native environment per episode; same pinned actor/customer interface in every arm. Three-arm schedule rotates order across repetitions; independent serial provider lanes run blocks concurrently. Cache/provider timing and unseeded sampling remain confounders. Native task labels/solutions never enter actor prompts or reminders.",
    endpoints:
      "Report all assigned episodes: natural completion, native success, observation/grounding failures, resource stops, nonempty reporting, refreshed facts, reminder opportunities/deliveries and next diagnostic action. Primary task metric is verified native success AND natural completion, with all failures/stops counted. Conditional-vs-baseline and conditional-vs-static case-averaged paired deltas with descriptive case-cluster bootstrap intervals; also costs/calls, raw per-case and per-repeat results. Nine distinct cases, not 81 independent tasks. No general-population significance claim.",
    gateDecision:
      "Compliance stage requires all six natural completions and nonempty public reports, no interface failures, and refreshed facts in at least two distinct cases, plus exact replay and cost audit. Then and only then run the already specified comparison panel. Comparison keeps all outcomes; no exclusions to make an arm look better. Interface failure rate or zero reminder activation limits interpretation. No production promotion.",
    noTuning:
      "Freeze before collection. No within-stage changes, retry, replacement or case selection from new outcomes. Comparison cases are fixed in the profile source before compliance starts. Any later fix gets a new revision/protocol and fresh evaluation cases; consumed failures remain development evidence. Receipt uncertainty stops further dispatch on its lane; fatal errors stop the stage. No silently repeated paid calls.",
    learningBoundary:
      "This measures a host-authored reminder, not autonomous learning or peer transfer. A positive result justifies a separate source-failure-to-recipient comparison with baseline/static/verified-procedure controls on reserved cases.",
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  fs.mkdirSync(path.join(root, "source"));
  const files = [
    ...new Set([
      ...qualification.sources.map((s) => s.file),
      qualificationPath,
      ...[
        "evidence-protocol.mjs",
        "evidence-protocol.test.mjs",
        "evidence-study.mjs",
        "evidence-analyze.mjs",
      ].map((f) => "benchmarks/learning-strategy/telecom/" + f),
    ]),
  ];
  const sources = files.map((file, i) => {
    const bytes = fs.readFileSync(file),
      snapshot = `source/${i}-${path.basename(file)}`;
    fs.writeFileSync(path.join(root, snapshot), bytes);
    return { file, snapshot, sha256: hash(bytes.toString("utf8")) };
  });
  write("freeze.json", {
    at: new Date().toISOString(),
    protocolHash: hash(protocol),
    sources,
    node: process.version,
  });
  write("preflight.json", {
    status: "ready",
    episodes: protocol.schedule.reduce((s, b) => s + b.indices.length, 0),
    concurrency: profile.concurrency,
    circuitBreakerUsd: protocol.newSpendCircuitBreakerUsd,
    priorExposureUsd: priorExposure(resultsRoot).reduce((s, r) => s + r.usd, 0),
    providerCallsMade: 0,
  });
  console.log(JSON.stringify(read("preflight.json")));
} else {
  const protocol = read("protocol.json"),
    freeze = read("freeze.json");
  assert.equal(hash(protocol), freeze.protocolHash);
  for (const source of freeze.sources) {
    assert.equal(
      hash(fs.readFileSync(source.file, "utf8")),
      source.sha256,
      `Changed source: ${source.file}`,
    );
    assert.equal(hash(fs.readFileSync(path.join(root, source.snapshot), "utf8")), source.sha256);
  }
  assert.ok(
    protocol.indices.every((i) => !consumedCases().includes(i)),
    "Case consumed after preparation",
  );
  const lockPath = path.join(resultsRoot, ".collector.lock"),
    lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  try {
    const prior = priorExposure(resultsRoot),
      exposure = prior.reduce((s, r) => s + r.usd, 0);
    write("project-budget.json", {
      ceiling: exposure + protocol.newSpendCircuitBreakerUsd,
      priorExposure: prior,
      authorization: protocol.authorization,
      newSpendCircuitBreakerUsd: protocol.newSpendCircuitBreakerUsd,
    });
    // Disjoint fixed lane allocations bound aggregate exposure even with concurrent requests.
    // All lanes append synchronously to the same durable UUID-keyed provider ledger.
    const providers = Array.from({ length: protocol.concurrency }, () =>
      createProvider(root, protocol.laneCeilingUsd),
    );
    const evaluations = [],
      executions = [];
    let nextBlock = 0,
      fatal = null;
    const status = () => {
      const lanes = providers.map((p) => p.status());
      return {
        spent: lanes.reduce((s, p) => s + p.spent, 0),
        reserved: lanes.reduce((s, p) => s + p.reserved, 0),
        unresolved: lanes.reduce((s, p) => s + p.unresolved, 0),
        ceiling: protocol.newSpendCircuitBreakerUsd,
        lanes,
      };
    };
    const native = JSON.parse(fs.readFileSync(path.join(here, "native-sources.json"), "utf8"));
    const scope = {
      tool: "tau2-telecom-native",
      version: native.commit,
      operation: "customer-support",
      contractHash: hash({ native, adapterRevision: ADAPTER_REVISION }),
    };
    const worker = async (lane) => {
      while (!fatal && nextBlock < protocol.schedule.length) {
        const blockIndex = nextBlock++,
          block = protocol.schedule[blockIndex];
        fs.appendFileSync(
          path.join(root, "lanes.jsonl"),
          JSON.stringify({ lane, blockIndex, store: block.store }) + "\n",
        );
        const budget = {
          providerUsd: block.indices.length * protocol.perEpisodeUsd,
          toolCalls: block.indices.length * 1000,
          wallMs: block.indices.length * 1800000,
        };
        const service = new ProceduralLearning(
          new ProceduralLearningStore(new DatabaseSync(path.join(root, block.store + ".sqlite")), {
            mode: "shadow",
            maxEntries: 100,
            executionBudget: budget,
          }),
        );
        try {
          const lab = service.strategies,
            actor = block.arm === "static" ? protocol.staticActor : protocol.initialActor,
            reminders = block.arm === "conditional" ? protocol.reminders : [];
          const target = lab.archive.add({
            schemaVersion: 1,
            scope,
            actor,
            proposer: PROPOSER,
            ...(reminders.length ? { reminders } : {}),
            parents: [],
            sharing: "private",
            expiresAt: Date.now() + 7 * 86400000,
          });
          lab.registerPanel({
            id: block.store,
            scope,
            partition: "held-out",
            model,
            verifierHash: hash(fs.readFileSync(path.join(here, "native.py"), "utf8")),
            isolation: "sandbox",
            reminderFacts: protocol.reminderFacts,
            cases: block.indices.map((index) => ({ id: `case-${index}`, input: { index } })),
            quote: () => ({
              providerUsd: protocol.perEpisodeUsd,
              toolCalls: 1000,
              wallMs: 1800000,
            }),
            execute: async (candidate, input, signal) => {
              if (fatal) throw Error("Study stopped after another lane failed");
              const label = `${block.arm}-${block.repetition}-${input.index}`;
              console.log(JSON.stringify({ event: "episode-start", label, lane }));
              const result = await runEpisode({
                index: input.index,
                strategy: candidate.actor,
                reminders: candidate.reminders ?? [],
                tag: label,
                signal,
                maxCalls: protocol.maxCalls,
                maxUsd: protocol.perEpisodeUsd,
                conversationCache: protocol.conversationCache,
                observationMode: protocol.observationMode,
                provider: {
                  call: async (...args) => {
                    if (fatal) throw Error("Study stopped after another lane failed");
                    return providers[lane].call(...args);
                  },
                },
                onEvent: (event) =>
                  fs.appendFileSync(
                    path.join(root, "events.jsonl"),
                    JSON.stringify({ ...event, label, lane, at: new Date().toISOString() }) + "\n",
                  ),
              });
              write(`episode-${label}.json`, result);
              executions.push({
                label,
                index: input.index,
                arm: block.arm,
                repetition: block.repetition,
                strategy: candidate.actor,
                reminders: candidate.reminders ?? [],
              });
              console.log(
                JSON.stringify({
                  event: "episode-complete",
                  label,
                  passed: result.verdict.passed,
                  reason: result.reason,
                  cost: result.cost,
                }),
              );
              return { output: result, cost: result.cost };
            },
            verify: async (_input, result) => ({
              passed:
                result.verdict.passed && ["user-ended", "human-transfer"].includes(result.reason),
              feedback: "held-out",
              cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
            }),
          });
          lab.archive.seal(scope, [target]);
          const result = await lab.evaluate(target, block.store, budget);
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
