import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import {
  bindPublicIdentity,
  generateProcedure,
  retainedEvidence,
  procedureRequest,
  runGuardedAttempt,
  summarizeGuarded,
  panelSummary,
  qualificationGate,
} from "./guarded-procedure-runtime.mjs";
import { checkFreeze, freezeSources } from "./procedure-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./rediscovery2-provider.mjs";

const [command, rootArg, parentArg] = process.argv.slice(2);
assert.ok(rootArg, "Usage: guarded-procedure-study.mjs prepare|collect ROOT [PARENT]");
const root = path.resolve(rootArg),
  resultsRoot = path.dirname(root);
const readAt = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const read = (n) => readAt(root, n);
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const fileHash = (f) => hash(fs.readFileSync(f, "utf8"));
const sourceFor = (i) => {
  assert.equal(fileHash(path.join(root, i.input)), i.sha256);
  return { index: i.index, episode: read(i.input) };
};
if (command === "prepare") {
  const parent = path.resolve(parentArg),
    parentFreeze = checkFreeze(parent),
    pp = readAt(parent, "protocol.json");
  assert.equal(pp.kind, "telecom-failure-engineered-repair-controller");
  assert.equal(readAt(parent, "audit.json").status, "passed");
  const discovery = path.join(resultsRoot, "telecom-corrected-discovery-v1");
  checkFreeze(discovery);
  assert.ok(!fs.existsSync(root));
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "inputs"));
  const inputs = pp.inputs.map((i) => ({ ...i, scope: "primary" }));
  for (const i of inputs)
    fs.copyFileSync(
      path.join(parent, i.input),
      path.join(root, i.input),
      fs.constants.COPYFILE_EXCL,
    );
  const sources = inputs.map((i) => ({ alias: i.alias, ...sourceFor(i) }));
  sources.forEach((s) => bindPublicIdentity(s.episode));
  const repairs = readAt(parent, "retention.json").records.map((r) => {
    assert.equal(r.status, "verified");
    return readAt(parent, `repair-${r.label}.json`);
  });
  const evidence = retainedEvidence(
    sources,
    pp.assignments.map((a) => readAt(parent, `attempt-${a.label}.json`)),
    repairs,
  );
  let context;
  const probe = await runDiagnosticSession({
    alias: inputs[0].alias,
    source: sourceFor(inputs[0]),
    selectAction: async (view) => {
      context = { policy: view.policy, tools: view.tools };
      return null;
    },
  });
  assert.equal(probe.status, "stopped");
  assert.equal(probe.afterPassed, false);
  const nativeRoot = "benchmarks/learning-strategy/telecom/vendor/src/tau2/domains/telecom";
  for (const [role, file] of [
    ["assistant", "tools.py"],
    ["user", "user_tools.py"],
  ]) {
    const effects = new Map(
      [
        ...fs
          .readFileSync(path.join(nativeRoot, file), "utf8")
          .matchAll(/@is_tool\(ToolType\.(READ|WRITE|GENERIC)\)\s+def\s+(\w+)\(/g),
      ].map((m) => [m[2], m[1]]),
    );
    for (const t of context.tools.filter((t) => t.role === role)) {
      t.effect = effects.get(t.name);
      assert.ok(["READ", "WRITE"].includes(t.effect));
    }
  }
  assert.ok(Buffer.byteLength(JSON.stringify(procedureRequest(context, evidence))) < 285000);
  const primaryHashes = new Set(inputs.map((i) => i.sha256)),
    panelInputs = [];
  for (const row of readAt(discovery, "complete.json").episodes.filter((a) =>
    inputs.some((i) => i.index === a.index),
  )) {
    const filename = `episode-${row.label}.json`,
      full = path.join(discovery, filename),
      sha256 = fileHash(full),
      episode = readAt(discovery, filename);
    if (primaryHashes.has(sha256)) continue;
    assert.ok(["human-transfer", "user-ended"].includes(episode.reason));
    assert.equal(episode.verdict.replayMatch, true);
    assert.equal(episode.verdict.unrelatedPreserved, true);
    const input = `inputs/panel-${row.label}.json`;
    fs.copyFileSync(full, path.join(root, input), fs.constants.COPYFILE_EXCL);
    let bindingError = null;
    try {
      bindPublicIdentity(episode);
    } catch (error) {
      bindingError = error.message;
    }
    panelInputs.push({
      index: row.index,
      alias: `panel-${panelInputs.length}`,
      input,
      sha256,
      scope: "panel",
      parent: row.label,
      beforePassed: episode.verdict.passed,
      bindingError,
    });
  }
  assert.equal(panelInputs.length, 44);
  assert.equal(panelInputs.filter((i) => i.beforePassed).length, 16);
  const candidates = ["candidate-0", "candidate-1"],
    assignments = [];
  for (let repetition = 0; repetition < 3; repetition++)
    for (const [i, input] of inputs.entries()) {
      const arms = candidates
        .flatMap((candidate) => ["advice", "compiled"].map((arm) => ({ arm, candidate })))
        .concat({ arm: "retrieval", candidate: null });
      const rotated = arms.slice((i + repetition) % 5).concat(arms.slice(0, (i + repetition) % 5));
      for (const row of rotated)
        assignments.push({
          ...row,
          label: `${row.arm}-${row.candidate ?? "shared"}-r${repetition}-${input.alias}`,
          repetition,
          index: input.index,
          alias: input.alias,
          scope: "primary",
        });
    }
  const panelAssignments = panelInputs.flatMap((i) =>
    candidates.map((candidate) => ({
      label: `compiled-${candidate}-${i.alias}`,
      arm: "compiled",
      candidate,
      index: i.index,
      alias: i.alias,
      scope: "panel",
    })),
  );
  write("learning-evidence.json", evidence);
  write("public-context.json", context);
  write("qualification.json", {
    providerCalls: 0,
    probe,
    bindings: sources.map((s) => bindPublicIdentity(s.episode)),
    panelBindingAbstentions: panelInputs.filter((i) => i.bindingError).length,
  });
  const protocol = {
    kind: "telecom-guarded-procedure-reuse",
    version: 1,
    model,
    rates,
    candidates,
    inputs,
    panelInputs,
    assignments,
    panelAssignments,
    sourceRun: path.basename(parent),
    sourceAuditHash: fileHash(path.join(parent, "audit.json")),
    panelSourceRun: path.basename(discovery),
    evidenceHash: fileHash(path.join(root, "learning-evidence.json")),
    contextHash: fileHash(path.join(root, "public-context.json")),
    controls:
      "Two independent procedures generated from the same verified repairs and prior public diagnostic observations. At most two generation calls each, one compiler-only correction. No human repair recipe, task-outcome revisions or candidate selection. Both sealed before evaluation. Compare each exact artifact as compiled procedure versus LLM advice; raw evidence retrieval is shared control. Same primary inputs, identity binding, policy, six native actions/eight decisions. Advice/retrieval 2048 output tokens/decision. All assignments retained.",
    panel:
      "All44 other consumed final states of the same four development cases, including28 failed and16 healthy. Generation receives none of their traces. Missing/ambiguous public identity causes zero-action abstention and remains in denominator. This is state reuse, not fresh-case or recipient transfer. Repeated deterministic executions are not independent samples.",
    gate: "Both candidates valid; primary noerrors; each compiled >=10/12 repairs and >=its advice arm; each panel repairs >=half of all28 failed states, preserves all16 healthy states with zero WRITE actions, noerrors and no false self-verification. Gate qualifies development reuse only. Mechanism advantage reported separately; no requirement to manufacture improvement over advice.",
    reservedRecipients: [11, 12, 15, 49],
    generatorCeilingUsd: 25,
    laneCeilingUsd: 40,
    concurrency: 3,
    authorization:
      "Thorough paid synthetic experiments authorized; ceilings are circuit breakers. No live activation, propagation or publication.",
  };
  write("protocol.json", protocol);
  freezeSources(root, protocol, [
    ...parentFreeze.sources.map((s) => s.file),
    ...[
      "guarded-procedure-runtime.mjs",
      "guarded-procedure-runtime.test.mjs",
      "guarded-procedure-study.mjs",
      "guarded-procedure-audit.mjs",
    ].map((n) => `benchmarks/learning-strategy/telecom/${n}`),
  ]);
  console.log(
    JSON.stringify({
      status: "prepared",
      primary: assignments.length,
      panel: panelAssignments.length,
      evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)),
      identityAbstentions: panelInputs.filter((i) => i.bindingError).length,
    }),
  );
} else if (command === "collect") {
  checkFreeze(root);
  const p = read("protocol.json");
  assert.equal(p.kind, "telecom-guarded-procedure-reuse");
  assert.equal(fileHash(path.join(root, "learning-evidence.json")), p.evidenceHash);
  assert.equal(fileHash(path.join(root, "public-context.json")), p.contextHash);
  assert.ok(
    !fs.existsSync(path.join(root, "provider.jsonl")) &&
      !fs.existsSync(path.join(root, "complete.json")),
  );
  const lock = path.join(resultsRoot, ".collector.lock"),
    fd = fs.openSync(lock, "wx");
  fs.writeSync(fd, JSON.stringify({ id: path.basename(root), pid: process.pid }));
  fs.closeSync(fd);
  try {
    const prior = priorExposure(resultsRoot),
      priorUsd = prior.reduce((s, r) => s + r.usd, 0);
    write("exposure-before.json", { priorUsd, unresolved: prior.filter((r) => r.unresolved) });
    const generator = createProvider(root, p.generatorCeilingUsd),
      context = read("public-context.json"),
      evidence = read("learning-evidence.json"),
      artifacts = [];
    for (const candidate of p.candidates) {
      const generated = await generateProcedure(generator, candidate, context, evidence);
      write(`generation-${candidate}.json`, generated);
      artifacts.push({
        candidate,
        valid: generated.valid,
        procedure: generated.procedure,
        generationUsd: generated.calls.reduce((s, c) => s + c.usd, 0),
      });
      console.log(
        JSON.stringify({
          generated: candidate,
          valid: generated.valid,
          calls: generated.calls.length,
        }),
      );
    }
    write("artifacts.json", { artifacts, generationCompleteBeforeEvaluation: true });
    const providers = Array.from({ length: p.concurrency }, () =>
      createProvider(root, p.laneCeilingUsd),
    );
    let cursor = 0;
    const assignments = [...p.assignments, ...p.panelAssignments],
      attempts = [];
    await Promise.all(
      providers.map(async (provider) => {
        while (cursor < assignments.length) {
          const assignment = assignments[cursor++],
            input = [...p.inputs, ...p.panelInputs].find((i) => i.alias === assignment.alias),
            artifact = artifacts.find((a) => a.candidate === assignment.candidate)?.procedure;
          const attempt = await runGuardedAttempt({
            assignment,
            source: sourceFor(input),
            artifact,
            evidence,
            provider,
            context,
          });
          write(`attempt-${assignment.label}.json`, attempt);
          attempts.push(attempt);
          console.log(
            JSON.stringify({
              label: assignment.label,
              passed: attempt.result.afterPassed,
              status: attempt.procedureState?.status ?? attempt.result.status,
              calls: attempt.cost.modelCalls,
              usd: attempt.cost.providerUsd,
            }),
          );
        }
      }),
    );
    const ordered = assignments.map((a) => attempts.find((t) => t.assignment.label === a.label)),
      primary = ordered.filter((a) => a.assignment.scope === "primary"),
      panel = ordered.filter((a) => a.assignment.scope === "panel");
    const summary = summarizeGuarded(p.assignments, primary),
      additional = panelSummary(p.panelAssignments, panel, context),
      provider = [generator, ...providers].map((v) => v.status());
    const complete = {
      status: "complete",
      artifactHash: fileHash(path.join(root, "artifacts.json")),
      summary,
      panel: additional,
      gatePassed: qualificationGate(artifacts, summary, additional),
      provider,
      priorExposureUsd: priorUsd,
      cumulativeExposureUsd: priorUsd + provider.reduce((s, r) => s + r.spent + r.reserved, 0),
    };
    write("complete.json", complete);
    console.log(JSON.stringify(complete));
  } finally {
    fs.unlinkSync(lock);
  }
} else throw Error("Unknown command");
