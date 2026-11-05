import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import {
  ARMS,
  runRepairAttempt,
  summarizeRepairs,
  verifyRepairSequence,
} from "./interactive-repair-runtime.mjs";
import { checkFreeze, freezeSources } from "./procedure-protocol.mjs";
import { publicTrace } from "./rediscovery2-engineer.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./rediscovery2-provider.mjs";

const [command, rootArg, sourceArg] = process.argv.slice(2);
assert.ok(
  rootArg,
  "Usage: interactive-repair-study.mjs prepare|qualify|collect|verify NEW-ROOT [SOURCE-ROOT]",
);
const root = path.resolve(rootArg),
  resultsRoot = path.dirname(root);
const readAt = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const read = (name) => readAt(root, name);
const write = (name, value) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const bytesHash = (file) => hash(fs.readFileSync(file, "utf8"));
const loadSource = (entry) => {
  assert.equal(bytesHash(path.join(root, entry.input)), entry.sha256);
  return { index: entry.index, episode: read(entry.input) };
};

if (command === "prepare") {
  assert.ok(sourceArg);
  const sourceRoot = path.resolve(sourceArg),
    sourceFreeze = checkFreeze(sourceRoot);
  assert.equal(readAt(sourceRoot, "audit.json").status, "passed");
  assert.equal(readAt(sourceRoot, "protocol.json").stage, "discovery");
  assert.ok(!fs.existsSync(root), "Output must be new; do not overwrite or resume a study");
  const complete = readAt(sourceRoot, "complete.json"),
    inputs = [];
  // Choose by frozen mechanical order, not the diagnosed cause or prospective result.
  for (const [ordinal, index] of [36, 37, 39, 44].entries()) {
    const eligible = complete.episodes
      .filter((e) => e.index === index)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((entry) => ({ entry, episode: readAt(sourceRoot, `episode-${entry.label}.json`) }))
      .filter(
        ({ episode: e }) =>
          !e.verdict.passed &&
          e.verdict.replayMatch &&
          e.verdict.unrelatedPreserved &&
          ["human-transfer", "user-ended"].includes(e.reason),
      );
    assert.ok(eligible.length);
    const selected = eligible[0],
      file = `episode-${selected.entry.label}.json`;
    assert.ok(Buffer.byteLength(JSON.stringify(publicTrace(selected.episode))) < 180000);
    inputs.push({
      index,
      alias: `case-${ordinal}`,
      parentLabel: selected.entry.label,
      eligibleCount: eligible.length,
      input: `inputs/${file}`,
      sha256: bytesHash(path.join(sourceRoot, file)),
    });
  }
  const assignments = [];
  for (let repetition = 0; repetition < 3; repetition++)
    for (const [ordinal, source] of inputs.entries()) {
      const arms = (ordinal + repetition) % 2 ? [...ARMS].reverse() : ARMS;
      for (const arm of arms)
        assignments.push({
          label: `${arm}-r${repetition}-${source.alias}`,
          arm,
          repetition,
          index: source.index,
          alias: source.alias,
        });
    }
  const protocol = {
    kind: "telecom-interactive-repair-discovery",
    version: 1,
    sourceRun: path.basename(sourceRoot),
    sourceAuditHash: bytesHash(path.join(sourceRoot, "audit.json")),
    sourceFreezeHash: bytesHash(path.join(sourceRoot, "freeze.json")),
    selection:
      "First lexicographic naturally terminated, failed, replay-matching and unrelated-state-preserving episode per consumed development case 36,37,39,44. One state per case; all three repetitions retained.",
    inputs,
    assignments,
    indices: inputs.map((i) => i.index),
    model,
    rates,
    maxActions: 6,
    interactiveMaxDecisions: 8,
    batchMaxModelCalls: 1,
    maxOutputTokens: { batch: 2048, interactive: 1024 },
    concurrency: 3,
    laneCeilingUsd: 30,
    mechanismGate:
      "All 24 assignments completed without interface/provider errors; interactive repairs at least three more than batch and has no case-level regression. This development screen is not a generalization claim.",
    retention:
      "For each successful attempt in both arms, replay the full returned action sequence on the exact original failed state, then separately omit each action while keeping every other action unchanged. Retain all results. Label an action necessary-on-input only if the full sequence succeeds and its omission fails with valid native replay and preserved unrelated state. No model sees verification outcomes during acquisition.",
    controls:
      "Same complete actor-visible failed trace, policy, role-qualified catalog, model, starting binary grade and six native action opportunity. Batch commits before tool outputs; interactive selects after each output, up to eight decisions including rejection feedback. Different call counts and cost are measured, not equated. No human diagnosis, hidden scenario or criterion-level evaluator feedback enters requests. No request retries or human repairs.",
    limitation:
      "Consumed, selected hard development states; four case clusters. Privileged diagnostics can operate both account/device tools and do not simulate new consent conversations. Not normal-agent performance, model-weight learning, cross-user benefit, or official tau-bench parity.",
    authorization:
      "User authorized thorough paid experiments without the old cap and approved proceeding. Finite circuit breakers are engineering guards, not user budgets. Private research; no live activation or peer publication.",
  };
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "inputs"));
  for (const input of inputs)
    fs.copyFileSync(
      path.join(sourceRoot, `episode-${input.parentLabel}.json`),
      path.join(root, input.input),
      fs.constants.COPYFILE_EXCL,
    );
  write("protocol.json", protocol);
  freezeSources(root, protocol, [
    ...sourceFreeze.sources.map((s) => s.file),
    ...[
      "diagnostic-actions.mjs",
      "diagnostic-session.mjs",
      "diagnostic-session.test.mjs",
      "interactive-repair-runtime.mjs",
      "interactive-repair-runtime.test.mjs",
      "interactive-repair-study.mjs",
      "interactive-repair-audit.mjs",
    ].map((n) => `benchmarks/learning-strategy/telecom/${n}`),
  ]);
  console.log(JSON.stringify({ status: "prepared", assignments: assignments.length, inputs }));
} else {
  checkFreeze(root);
  const p = read("protocol.json");
  assert.equal(p.kind, "telecom-interactive-repair-discovery");
  for (const input of p.inputs) loadSource(input);
  if (command === "qualify") {
    const rows = [];
    for (const input of p.inputs) {
      const result = await runDiagnosticSession({
        alias: input.alias,
        source: loadSource(input),
        selectAction: async () => null,
      });
      rows.push({ input, result });
    }
    const passed = rows.every(
      (r) =>
        r.result.status === "stopped" &&
        r.result.beforePassed === false &&
        r.result.afterPassed === false,
    );
    write("qualification.json", { status: passed ? "passed" : "failed", providerCalls: 0, rows });
    assert.ok(passed, "Parent replay qualification failed");
    console.log(JSON.stringify({ status: "passed", qualifiedStates: rows.length }));
  } else if (command === "collect") {
    assert.equal(read("qualification.json").status, "passed");
    assert.ok(
      !fs.existsSync(path.join(root, "provider.jsonl")) &&
        !fs.existsSync(path.join(root, "complete.json")),
      "Never resume or overwrite a paid collection",
    );
    const lock = path.join(resultsRoot, ".collector.lock");
    const fd = fs.openSync(lock, "wx");
    fs.writeSync(fd, JSON.stringify({ id: path.basename(root), pid: process.pid }));
    fs.closeSync(fd);
    try {
      const prior = priorExposure(resultsRoot),
        before = prior.reduce((s, r) => s + r.usd, 0);
      write("exposure-before.json", {
        priorUsd: before,
        unresolved: prior.filter((r) => r.unresolved),
        circuitBreakerUsd: p.concurrency * p.laneCeilingUsd,
      });
      const providers = Array.from({ length: p.concurrency }, () =>
        createProvider(root, p.laneCeilingUsd),
      );
      let cursor = 0;
      const attempts = [];
      await Promise.all(
        providers.map(async (provider) => {
          while (cursor < p.assignments.length) {
            const assignment = p.assignments[cursor++],
              input = p.inputs.find((i) => i.index === assignment.index);
            const attempt = await runRepairAttempt({
              assignment,
              source: loadSource(input),
              provider,
            });
            write(`attempt-${assignment.label}.json`, attempt);
            attempts.push(attempt);
            console.log(
              JSON.stringify({
                label: assignment.label,
                passed: attempt.result.afterPassed,
                status: attempt.result.status,
                ...attempt.cost,
              }),
            );
          }
        }),
      );
      const summary = summarizeRepairs(p.assignments, attempts);
      const status = providers.map((v) => v.status());
      write("complete.json", {
        status: "complete",
        assignments: p.assignments,
        summary,
        provider: status,
        priorExposureUsd: before,
        cumulativeExposureUsd: before + status.reduce((s, r) => s + r.spent + r.reserved, 0),
      });
      console.log(JSON.stringify(summary));
    } finally {
      fs.unlinkSync(lock);
    }
  } else if (command === "verify") {
    assert.equal(read("complete.json").status, "complete");
    const records = [];
    for (const assignment of p.assignments) {
      const attempt = read(`attempt-${assignment.label}.json`);
      if (attempt.result.afterPassed !== true) continue;
      const input = p.inputs.find((i) => i.index === assignment.index);
      const record = await verifyRepairSequence({ assignment, source: loadSource(input), attempt });
      record.sourceHash = input.sha256;
      record.attemptHash = bytesHash(path.join(root, `attempt-${assignment.label}.json`));
      write(`repair-${assignment.label}.json`, record);
      records.push(record);
      console.log(
        JSON.stringify({
          label: assignment.label,
          status: record.status,
          necessaryOnInput: record.necessaryOnInput,
          replays: record.rows.length,
        }),
      );
    }
    write("retention.json", {
      status: "complete",
      providerCalls: 0,
      records: records.map((r) => ({
        label: r.assignment.label,
        status: r.status,
        necessaryOnInput: r.necessaryOnInput,
        replays: r.rows.length,
      })),
      explanation:
        "Evidence capsules preserve each observed sequence and its exact-input omission results. They are private, input-bound artifacts, not generalized executable skills. No normal-agent retention or recipient benefit has been measured.",
    });
  } else throw Error(`Unknown command: ${command}`);
}
