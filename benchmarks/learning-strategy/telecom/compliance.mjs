import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { ACTOR, PROPOSER, ADAPTER_REVISION, runEpisode } from "./episode.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./provider.mjs";
import { STRUCTURED_REMINDER_FACTS } from "./reminders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(here, "../results");
const [mode, id] = process.argv.slice(2);
assert.ok(
  ["prepare", "run"].includes(mode) && /^[a-zA-Z0-9_-]+$/.test(id ?? ""),
  "Usage: compliance.mjs prepare|run unique-id",
);
const root = path.join(resultsRoot, id);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const cumulativeCap = 15,
  newSpendCap = 1;
function consumedCases() {
  const cases = new Set();
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === id) continue;
    const dir = path.join(resultsRoot, entry.name);
    if (!fs.existsSync(path.join(dir, "protocol.json"))) continue;
    if (
      !JSON.parse(fs.readFileSync(path.join(dir, "protocol.json"), "utf8")).kind?.startsWith(
        "telecom-",
      )
    )
      continue;
    const ledger = path.join(dir, "provider.jsonl");
    if (fs.existsSync(ledger))
      for (const line of fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        const match = row.type === "intent" && row.tag?.split(":")[0].match(/-(\d+)$/);
        if (match) cases.add(Number(match[1]));
      }
    for (const name of fs.readdirSync(dir)) {
      const match = name.match(/^episode-.*-(\d+)\.json$/);
      if (match) cases.add(Number(match[1]));
    }
  }
  return [...cases].sort((a, b) => a - b);
}
if (mode === "prepare") {
  const indices = [29, 33],
    consumed = consumedCases();
  assert.ok(
    indices.every((i) => !consumed.includes(i)),
    "Evaluation case already consumed",
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
  const native = JSON.parse(fs.readFileSync(path.join(here, "qualification-v1.json"), "utf8"));
  assert.ok(
    indices.every((index) => native.rows.some((r) => r.index === index && r.reference.passed)),
  );
  const protocol = {
    schemaVersion: 1,
    kind: "telecom-public-observation-compliance",
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    model,
    rates,
    indices,
    consumedCases: consumed,
    arms: ["conditional"],
    repetitions: 1,
    initialActor: ACTOR,
    initialProposer: PROPOSER,
    reminders: MISSING_DIAGNOSTIC_REMINDERS,
    reminderFacts: STRUCTURED_REMINDER_FACTS,
    maxCalls: 96,
    perEpisodeUsd: 1,
    conversationCache: true,
    cumulativeCapUsd: cumulativeCap,
    newSpendCapUsd: newSpendCap,
    purpose:
      "Real-model observation-interface compliance only; no efficacy comparison or learning claim.",
    caseSelection:
      "Two unused MMS cases selected prospectively from pinned metadata: 29 APN/device roaming and 33 permission/SIM/account roaming. Chosen for device/account-change coverage, not observed model outcomes. One draw per case in this fixed order; no replacement.",
    isolation:
      "Fresh shadow SQLite with one sealed two-case held-out panel; fresh native environment per episode. Private diagnostics are shared only through explicit selected public references. No hidden solutions or assertions enter prompts/routing.",
    decision:
      "Both episodes must finish naturally with at least one nonempty validated public report, no observation/grounding failure, exact frozen replay, full cost reconciliation and narrative review. Report refreshed-fact and reminder coverage separately. Zero exposure is unexercised, not success. Native repair success is descriptive. No learning-benefit conclusion.",
    noTuning:
      "Freeze before dispatch; no retries, replacement cases, changed prompts, rule tuning or promotion during collection. Run both cases even if the first yields an interface failure; fail-closed publication and all costs are retained. Stop on provider uncertainty or shared-budget refusal.",
    budget:
      "Explicit user approval: at most $1 new exposure within $15 cumulative. Conservative per-call reservations can censor collection before actual spending reaches $1. No cap override or automatic increase.",
  };
  const exposure = priorExposure(resultsRoot).reduce((sum, r) => sum + r.usd, 0);
  assert.ok(
    cumulativeCap - exposure >= newSpendCap,
    "Insufficient starting headroom for capped pilot",
  );
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  const files = [
    ...new Set([
      ...qualification.sources.map((s) => s.file),
      qualificationPath,
      ...[
        "compliance.mjs",
        "compliance-audit.mjs",
        "compliance-report.mjs",
        "compliance-report.test.mjs",
      ].map((f) => "benchmarks/learning-strategy/telecom/" + f),
    ]),
  ];
  fs.mkdirSync(path.join(root, "source"));
  const sources = files.map((file, i) => {
    const bytes = fs.readFileSync(file),
      snapshot = `source/${i}-${path.basename(file)}`;
    fs.writeFileSync(path.join(root, snapshot), bytes);
    return { file, snapshot, sha256: hash(bytes.toString("utf8")) };
  });
  write("freeze.json", {
    at: new Date().toISOString(),
    protocolHash: hash(protocol),
    node: process.version,
    sources,
  });
  write("preflight.json", {
    status: "ready",
    exposureUsd: exposure,
    remainingUsd: cumulativeCap - exposure,
    newSpendCapUsd: newSpendCap,
    episodes: 2,
    providerCallsMade: 0,
  });
  console.log(JSON.stringify(read("preflight.json")));
} else {
  const protocol = read("protocol.json"),
    freeze = read("freeze.json");
  assert.equal(hash(protocol), freeze.protocolHash);
  assert.equal(protocol.kind, "telecom-public-observation-compliance");
  assert.equal(protocol.newSpendCapUsd, newSpendCap);
  assert.equal(protocol.cumulativeCapUsd, cumulativeCap);
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
    "Evaluation case consumed after preparation",
  );
  const lockPath = path.join(resultsRoot, ".collector.lock"),
    lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  try {
    const prior = priorExposure(resultsRoot),
      exposure = prior.reduce((sum, r) => sum + r.usd, 0);
    assert.ok(cumulativeCap - exposure >= newSpendCap, "Insufficient starting headroom");
    write("project-budget.json", {
      ceiling: cumulativeCap,
      priorExposure: prior,
      newSpendCapUsd: newSpendCap,
      remaining: cumulativeCap - exposure,
    });
    const provider = createProvider(root, Math.min(newSpendCap, cumulativeCap - exposure));
    const executionManifest = [];
    const budget = { providerUsd: 2, toolCalls: 2000, wallMs: 3600000 };
    const service = new ProceduralLearning(
      new ProceduralLearningStore(new DatabaseSync(path.join(root, "compliance.sqlite")), {
        mode: "shadow",
        maxEntries: 100,
        executionBudget: budget,
      }),
    );
    try {
      const lab = service.strategies;
      const native = JSON.parse(fs.readFileSync(path.join(here, "native-sources.json"), "utf8"));
      const scope = {
        tool: "tau2-telecom-native",
        version: native.commit,
        operation: "customer-support",
        contractHash: hash({ native, adapterRevision: ADAPTER_REVISION }),
      };
      const target = lab.archive.add({
        schemaVersion: 1,
        scope,
        actor: protocol.initialActor,
        proposer: protocol.initialProposer,
        reminders: protocol.reminders,
        parents: [],
        sharing: "private",
        expiresAt: Date.now() + 7 * 86400000,
      });
      lab.registerPanel({
        id: "compliance",
        scope,
        partition: "held-out",
        model,
        verifierHash: hash(fs.readFileSync(path.join(here, "native.py"), "utf8")),
        isolation: "sandbox",
        reminderFacts: protocol.reminderFacts,
        cases: protocol.indices.map((index) => ({ id: `case-${index}`, input: { index } })),
        quote: () => ({ providerUsd: protocol.perEpisodeUsd, toolCalls: 1000, wallMs: 1800000 }),
        execute: async (candidate, input, signal) => {
          const label = `conditional-0-${input.index}`;
          console.log(JSON.stringify({ event: "episode-start", label }));
          const result = await runEpisode({
            index: input.index,
            strategy: candidate.actor,
            reminders: candidate.reminders,
            provider,
            tag: label,
            signal,
            maxCalls: protocol.maxCalls,
            maxUsd: protocol.perEpisodeUsd,
            conversationCache: protocol.conversationCache,
            onEvent: (event) =>
              fs.appendFileSync(
                path.join(root, "events.jsonl"),
                JSON.stringify({ ...event, label, at: new Date().toISOString() }) + "\n",
              ),
          });
          write(`episode-${label}.json`, result);
          executionManifest.push({
            label,
            index: input.index,
            strategy: candidate.actor,
            reminders: candidate.reminders,
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
          passed: result.verdict.passed && ["user-ended", "human-transfer"].includes(result.reason),
          feedback: "held-out",
          cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
        }),
      });
      lab.archive.seal(scope, [target]);
      const evaluation = await lab.evaluate(target, "compliance", budget);
      write("complete.json", {
        evaluation,
        executionManifest,
        provider: provider.status(),
        priorExposureUsd: exposure,
        cumulativeExposureUsd: exposure + provider.status().spent,
        collectionStatus:
          executionManifest.length === 2 &&
          executionManifest.every((e) =>
            ["user-ended", "human-transfer"].includes(read(`episode-${e.label}.json`).reason),
          )
            ? "complete"
            : "censored",
      });
      console.log(JSON.stringify({ event: "complete", provider: provider.status() }));
    } catch (error) {
      write("incomplete.json", {
        error: error.message,
        provider: provider.status(),
        executionManifest,
      });
      throw error;
    } finally {
      await service.close();
    }
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
