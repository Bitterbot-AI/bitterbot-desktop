import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  LearningStrategySchema,
  StrategyRemindersSchema,
} from "../../../src/memory/learning-strategy-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { MISSING_DIAGNOSTIC_REMINDERS } from "./diagnostic-observations.mjs";
import { DIAGNOSTIC_PROTOCOL } from "./diagnostic-protocol.mjs";
import { ACTOR, PROPOSER, runEpisode, ADAPTER_REVISION } from "./episode.mjs";
import { hash, createProvider, priorExposure, model, rates } from "./provider.mjs";
import { CONDITIONAL_REMINDERS, STRUCTURED_REMINDER_FACTS } from "./reminders.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsRoot = path.join(here, "../results");
const [mode, id, ceilingArgument] = process.argv.slice(2);
assert.ok(
  ["prepare", "prepare-diagnostic", "run"].includes(mode) && /^[a-zA-Z0-9_-]+$/.test(id ?? ""),
  "Usage: node --import tsx conditional.mjs prepare|prepare-diagnostic|run unique-id [approved-total-ceiling]",
);
const ceiling = ceilingArgument === undefined ? 10 : Number(ceilingArgument);
assert.ok(Number.isFinite(ceiling) && ceiling > 0 && ceiling <= 15, "Invalid explicit ceiling");
const diagnostic = mode === "prepare-diagnostic";
const rules = diagnostic ? MISSING_DIAGNOSTIC_REMINDERS : CONDITIONAL_REMINDERS;
const root = path.join(resultsRoot, id);
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (file, value) =>
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2), { flag: "wx" });
const budget = { providerUsd: 10, toolCalls: 20000, wallMs: 100000000 };
const zero = { providerUsd: 0, toolCalls: 0, wallMs: 0 };
const manifest = JSON.parse(fs.readFileSync(path.join(here, "native-sources.json"), "utf8"));
const scope = {
  tool: "tau2-telecom-native",
  version: manifest.commit,
  operation: "customer-support",
  contractHash: hash({ native: manifest, adapterRevision: ADAPTER_REVISION }),
};
const literalRules = rules
  .map(
    (rule) =>
      `When ${JSON.stringify(rule.when)}${rule.unless ? `, unless all ${JSON.stringify(rule.unless)}` : ""}: ${rule.text}`,
  )
  .join("\n");
StrategyRemindersSchema.parse(rules);

if (mode.startsWith("prepare")) {
  const priorCases = new Set();
  for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === id) continue;
    const file = path.join(resultsRoot, entry.name, "protocol.json");
    if (!fs.existsSync(file)) continue;
    const prior = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!prior.kind?.startsWith("telecom-")) continue;
    const ledger = path.join(path.dirname(file), "provider.jsonl");
    if (fs.existsSync(ledger)) {
      for (const line of fs.readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean)) {
        const row = JSON.parse(line);
        const match = row.type === "intent" && row.tag?.split(":")[0].match(/-(\d+)$/);
        if (match) priorCases.add(Number(match[1]));
      }
    }
    for (const name of fs
      .readdirSync(path.dirname(file))
      .filter((n) => /^episode-.*\.json$/.test(n))) {
      const match = name.match(/-(\d+)\.json$/);
      if (match) priorCases.add(Number(match[1]));
    }
  }
  const indices = diagnostic ? DIAGNOSTIC_PROTOCOL.indices : [1, 32, 42];
  assert.ok(
    indices.every((index) => !priorCases.has(index)),
    "Proposed evaluation case was already used",
  );
  assert.ok(
    rules.every((rule) =>
      [...rule.when, ...(rule.unless ?? [])].every((predicate) =>
        STRUCTURED_REMINDER_FACTS.includes(predicate.fact),
      ),
    ),
    "Candidate uses unsupported structured facts",
  );
  const protocol = {
    schemaVersion: 1,
    kind: "telecom-conditional-reminder-comparison",
    adapterRevision: ADAPTER_REVISION,
    observationMode: "structured",
    model,
    rates,
    indices,
    consumedCases: [...priorCases].sort((a, b) => a - b),
    arms: ["baseline", "static", "conditional"],
    repetitions: 2,
    schedule: [
      ...["baseline", "static", "conditional"].map((arm) => ({ arm, repetition: 0, indices })),
      ...["conditional", "static", "baseline"].map((arm) => ({
        arm,
        repetition: 1,
        indices: [...indices].reverse(),
      })),
    ],
    initialActor: ACTOR,
    initialProposer: PROPOSER,
    staticActor: ACTOR + "\n\nConditional troubleshooting reminders:\n" + literalRules,
    reminders: rules,
    reminderFacts: STRUCTURED_REMINDER_FACTS,
    maxCalls: 96,
    perEpisodeUsd: 1.25,
    conversationCache: true,
    minimumHeadroomUsd: 5,
    estimatedNewSpendUsd: [3, 5],
    recommendedTotalCeilingUsd: 15,
    hypothesis:
      "Host-triggered reminders preserve successful repairs with fewer unnecessary model/tool calls than the same rules always present in the prompt.",
    origin:
      "Host-authored engineering hypothesis from previous development traces, not an autonomously learned candidate or a recursive meta-learning experiment.",
    comparison:
      "Original actor; identical reminder predicates/text always present as instructions; same reminders selected by actor-visible observations. Timing and placement differ with selection. No verified-procedure-reuse control or live peer deployment.",
    caseSelection:
      "Before collection: one simple domestic mobile-data control, one MMS/data-allowance combination and one MMS/device-data/roaming combination. Deliberate mechanism coverage, not a representative sample. Native IDs and solutions never enter model prompts.",
    isolation:
      "Fresh SQLite per arm/repetition, sealed before held-out evaluation, fresh Python native environment per episode. Customer tools remain private. No native states or assertion details enter reminder routing.",
    decision:
      "Require all 18 natural completions. Report paired per-case/repetition success, tool calls, model calls, billed and uncached-equivalent cost. No accuracy regression on any pair; aggregate tool/model calls and uncached-equivalent cost must not increase against either control, with at least one strict reduction. This is a small exploratory gate, not statistical proof or live promotion.",
    noTuning:
      "Freeze before any evaluation call. No mutation, reselection, retries, or within-run tuning. All three indices become consumed after collection. Balanced block order reduces but does not eliminate caching/order effects; model sampling is unseeded.",
    budget:
      "Preparation makes no provider calls. Run defaults to the existing $10 cumulative cap. A larger CLI ceiling requires explicit user authorization; no code path increases it automatically. Fail before dispatch when less than $5 headroom remains.",
    ...(diagnostic ? DIAGNOSTIC_PROTOCOL : {}),
  };
  const qualificationPath =
    "benchmarks/learning-strategy/telecom/qualification-public-observations-v6.json";
  if (diagnostic) {
    const qualification = JSON.parse(fs.readFileSync(qualificationPath, "utf8"));
    assert.equal(qualification.status, "passed");
    assert.equal(qualification.adapterRevision, ADAPTER_REVISION);
    assert.equal(qualification.observationMode, "structured");
    assert.equal(qualification.rulesHash, hash(rules));
    for (const source of qualification.sources)
      assert.equal(
        hash(fs.readFileSync(source.file, "utf8")),
        source.sha256,
        `Stale qualification: ${source.file}`,
      );
    const native = JSON.parse(fs.readFileSync(path.join(here, "qualification-v1.json"), "utf8"));
    assert.ok(
      indices.every((index) =>
        native.rows.some((row) => row.index === index && row.reference.passed),
      ),
    );
  }
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  LearningStrategySchema.shape.actor.parse(protocol.staticActor);
  const pilot = JSON.parse(
    fs.readFileSync(path.join(resultsRoot, "telecom-native-pilot-v1/freeze.json"), "utf8"),
  );
  const files = [
    ...new Set([
      ...pilot.sources.map((s) => s.file),
      "src/memory/learning-strategy-reminders.ts",
      "benchmarks/learning-strategy/telecom/reminders.mjs",
      "benchmarks/learning-strategy/telecom/grounding.mjs",
      "benchmarks/learning-strategy/telecom/diagnostic-observations.mjs",
      "benchmarks/learning-strategy/telecom/public-observations.mjs",
      "benchmarks/learning-strategy/telecom/diagnostic-protocol.mjs",
      ...(diagnostic
        ? [
            qualificationPath,
            "benchmarks/learning-strategy/telecom/qualify-public-observations.mjs",
            "benchmarks/learning-strategy/telecom/public-observations.test.mjs",
            "benchmarks/learning-strategy/telecom/public-observation-variants.json",
            "benchmarks/learning-strategy/telecom/trace-observations.mjs",
          ]
        : []),
      "benchmarks/learning-strategy/telecom/conditional.mjs",
      "benchmarks/learning-strategy/telecom/audit.mjs",
      "benchmarks/learning-strategy/telecom/analyze.mjs",
      "benchmarks/learning-strategy/telecom/qualification-reminders-v1.json",
    ]),
  ];
  fs.mkdirSync(path.join(root, "source"));
  const sources = files.map((file, index) => {
    const bytes = fs.readFileSync(file),
      snapshot = `source/${index}-${path.basename(file)}`;
    fs.writeFileSync(path.join(root, snapshot), bytes);
    return { file: file.replaceAll("\\", "/"), snapshot, sha256: hash(bytes.toString("utf8")) };
  });
  write("freeze.json", {
    at: new Date().toISOString(),
    protocolHash: hash(protocol),
    node: process.version,
    sources,
  });
  const exposure = priorExposure(resultsRoot).reduce((sum, row) => sum + row.usd, 0);
  write("preflight.json", {
    status: ceiling - exposure >= protocol.minimumHeadroomUsd ? "ready" : "insufficient-headroom",
    existingCeilingUsd: ceiling,
    exposureUsd: exposure,
    remainingUsd: ceiling - exposure,
    episodes: protocol.schedule.reduce((sum, block) => sum + block.indices.length, 0),
    providerCallsMade: 0,
    recommendedTotalCeilingUsd: 15,
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
      `Changed collector source: ${source.file}`,
    );
    assert.equal(hash(fs.readFileSync(path.join(root, source.snapshot), "utf8")), source.sha256);
  }
  const lockPath = path.join(resultsRoot, ".collector.lock"),
    lock = fs.openSync(lockPath, "wx");
  fs.writeSync(lock, JSON.stringify({ pid: process.pid, id }));
  try {
    const prior = priorExposure(resultsRoot),
      exposure = prior.reduce((sum, row) => sum + row.usd, 0);
    if (ceiling - exposure < protocol.minimumHeadroomUsd)
      throw Error(
        `Insufficient authorized headroom: $${(ceiling - exposure).toFixed(2)}; collection needs $${protocol.minimumHeadroomUsd}. No provider call made.`,
      );
    write("project-budget.json", { ceiling, priorExposure: prior, remaining: ceiling - exposure });
    const provider = createProvider(root, ceiling - exposure),
      evaluations = [],
      executions = [];
    try {
      for (const block of protocol.schedule) {
        const storeName = block.store ?? `${block.arm}-${block.repetition}`;
        const service = new ProceduralLearning(
          new ProceduralLearningStore(new DatabaseSync(path.join(root, `${storeName}.sqlite`)), {
            mode: "shadow",
            maxEntries: 100,
            executionBudget: budget,
          }),
        );
        try {
          const lab = service.strategies;
          const actor = block.arm === "static" ? protocol.staticActor : protocol.initialActor;
          const reminders = block.arm === "conditional" ? protocol.reminders : [];
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
            id: storeName,
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
              const label = `${block.arm}-${block.repetition}-${input.index}`;
              console.log(JSON.stringify({ event: "episode-start", label }));
              const result = await runEpisode({
                index: input.index,
                strategy: candidate.actor,
                reminders: candidate.reminders ?? [],
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
              cost: zero,
            }),
          });
          lab.archive.seal(scope, [target]);
          const result = await lab.evaluate(target, storeName, budget);
          evaluations.push({ ...block, store: storeName, result });
        } finally {
          await service.close();
        }
        if (executions.some((e) => read(`episode-${e.label}.json`).reason === "budget-limit"))
          break;
      }
      write("complete.json", {
        evaluations,
        executionManifest: executions,
        provider: provider.status(),
        priorExposureUsd: exposure,
        cumulativeExposureUsd: exposure + provider.status().spent,
        collectionStatus:
          executions.length ===
            protocol.schedule.reduce((sum, block) => sum + block.indices.length, 0) &&
          executions.every((e) =>
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
        executionManifest: executions,
      });
      throw error;
    }
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}
