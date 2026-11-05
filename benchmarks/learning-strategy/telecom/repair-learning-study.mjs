import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import { checkFreeze, freezeSources } from "./procedure-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure } from "./rediscovery2-provider.mjs";
import {
  CONDITIONS,
  learningEvidence,
  controllerPacket,
  generateController,
  runControllerAttempt,
  summarizeLearning,
  verifyControllerSequence,
} from "./repair-learning-runtime.mjs";

const [command, rootArg, sourceArg] = process.argv.slice(2);
assert.ok(rootArg, "Usage: repair-learning-study.mjs prepare|collect|verify ROOT [SOURCE]");
const root = path.resolve(rootArg),
  resultsRoot = path.dirname(root);
const readAt = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const read = (n) => readAt(root, n);
const write = (n, value) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const fileHash = (file) => hash(fs.readFileSync(file, "utf8"));
const sourceFor = (input) => {
  assert.equal(fileHash(path.join(root, input.input)), input.sha256);
  return { index: input.index, episode: read(input.input) };
};
if (command === "prepare") {
  assert.ok(sourceArg);
  const parent = path.resolve(sourceArg),
    parentFreeze = checkFreeze(parent);
  assert.equal(readAt(parent, "audit.json").status, "passed");
  const parentProtocol = readAt(parent, "protocol.json");
  assert.equal(parentProtocol.kind, "telecom-interactive-repair-discovery");
  assert.ok(!fs.existsSync(root));
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "inputs"));
  const inputs = parentProtocol.inputs;
  for (const input of inputs)
    fs.copyFileSync(
      path.join(parent, input.input),
      path.join(root, input.input),
      fs.constants.COPYFILE_EXCL,
    );
  const sources = inputs.map((i) => ({ alias: i.alias, ...sourceFor(i) }));
  const parentAttempts = parentProtocol.assignments.map((a) =>
    readAt(parent, `attempt-${a.label}.json`),
  );
  const evidence = learningEvidence(sources, parentAttempts);
  let context;
  const qualification = await runDiagnosticSession({
    alias: inputs[0].alias,
    source: sourceFor(inputs[0]),
    selectAction: async (view) => {
      context = { policy: view.policy, tools: view.tools };
      return null;
    },
  });
  assert.equal(qualification.status, "stopped");
  assert.equal(qualification.afterPassed, false);
  for (const arm of CONDITIONS)
    assert.ok(Buffer.byteLength(JSON.stringify(controllerPacket(arm, context, evidence))) < 285000);
  write("learning-evidence.json", evidence);
  write("public-context.json", context);
  write("qualification.json", { status: "passed", providerCalls: 0, result: qualification });
  const assignments = [];
  for (let repetition = 0; repetition < 3; repetition++)
    for (const [i, input] of inputs.entries())
      for (const arm of (i + repetition) % 2 ? [...CONDITIONS].reverse() : CONDITIONS)
        assignments.push({
          label: `${arm}-r${repetition}-${input.alias}`,
          arm,
          repetition,
          index: input.index,
          alias: input.alias,
        });
  const protocol = {
    kind: "telecom-failure-engineered-repair-controller",
    version: 1,
    model,
    rates,
    sourceRun: path.basename(parent),
    sourceAuditHash: fileHash(path.join(parent, "audit.json")),
    inputs,
    assignments,
    indices: inputs.map((i) => i.index),
    evidenceHash: fileHash(path.join(root, "learning-evidence.json")),
    contextHash: fileHash(path.join(root, "public-context.json")),
    controls:
      "One controller per condition, same model/policy/tools/base controller and at most two generation attempts (one compiler-only revision). Only experience sees prior public failure traces and probe outcomes. Both evaluated as interactive agents with six native actions/eight decisions, 2048 output tokens per decision and rationale <=60 words requested. All assigned trials retained. No repair, tuning or replacement during evaluation. No human solution supplied.",
    selection:
      "Same four consumed development states as source experiment. Generation receives all prior summaries and the original public trace/first interactive attempt per case, fixed by ordinal regardless of outcome. Both controllers generated and sealed before any new evaluation.",
    gate: "Both generated controllers valid, all24 assignments without interface/provider errors; experience >=3 more repairs than blind and no case-level regression. Development screen only; no fresh/recipient gate is authorized by this result alone.",
    verification:
      "Replay every successful generated action sequence on its exact failed parent and omit each action separately. Preserve all results as private input-bound evidence; do not infer transfer or normal-agent execution benefit.",
    generatorCeilingUsd: 20,
    laneCeilingUsd: 30,
    concurrency: 3,
    authorization:
      "User authorized thorough paid research and failure-engineered autonomous learning; no former cap. Research circuit breakers only. No live activation or external publication.",
  };
  write("protocol.json", protocol);
  freezeSources(root, protocol, [
    ...parentFreeze.sources.map((s) => s.file),
    ...[
      "repair-learning-runtime.mjs",
      "repair-learning-runtime.test.mjs",
      "repair-learning-study.mjs",
      "repair-learning-audit.mjs",
    ].map((n) => `benchmarks/learning-strategy/telecom/${n}`),
  ]);
  console.log(
    JSON.stringify({
      status: "prepared",
      assignments: assignments.length,
      evidenceBytes: Buffer.byteLength(JSON.stringify(evidence)),
    }),
  );
} else {
  checkFreeze(root);
  const p = read("protocol.json");
  assert.equal(p.kind, "telecom-failure-engineered-repair-controller");
  assert.equal(fileHash(path.join(root, "learning-evidence.json")), p.evidenceHash);
  assert.equal(fileHash(path.join(root, "public-context.json")), p.contextHash);
  if (command === "collect") {
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
        controllers = [];
      for (const arm of CONDITIONS) {
        const generation = await generateController(
          generator,
          arm,
          read("public-context.json"),
          read("learning-evidence.json"),
        );
        write(`generation-${arm}.json`, generation);
        controllers.push({
          arm,
          valid: generation.generated.valid,
          instructions: generation.generated.valid ? generation.generated.program.instructions : "",
          generationUsd: generation.usd,
        });
        console.log(
          JSON.stringify({
            generated: arm,
            valid: generation.generated.valid,
            usd: generation.usd,
          }),
        );
      }
      write("controllers.json", { controllers, generationCompleteBeforeEvaluation: true });
      const controllerHash = fileHash(path.join(root, "controllers.json"));
      const providers = Array.from({ length: p.concurrency }, () =>
          createProvider(root, p.laneCeilingUsd),
        ),
        attempts = [];
      let cursor = 0;
      await Promise.all(
        providers.map(async (provider) => {
          while (cursor < p.assignments.length) {
            const assignment = p.assignments[cursor++],
              controller = controllers.find((c) => c.arm === assignment.arm);
            const attempt = await runControllerAttempt({
              assignment,
              controller: controller.instructions,
              source: sourceFor(p.inputs.find((i) => i.index === assignment.index)),
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
      // Canonical assignment order avoids completion timing changing case order or floating sums.
      const ordered = p.assignments.map((a) =>
        attempts.find((t) => t.assignment.label === a.label),
      );
      const summary = summarizeLearning(p.assignments, ordered);
      summary.gatePassed &&= controllers.every((c) => c.valid);
      const provider = [generator, ...providers].map((v) => v.status());
      write("complete.json", {
        status: "complete",
        assignments: p.assignments,
        controllerHash,
        summary,
        provider,
        priorExposureUsd: priorUsd,
        cumulativeExposureUsd: priorUsd + provider.reduce((s, r) => s + r.spent + r.reserved, 0),
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
      const record = await verifyControllerSequence({
        assignment,
        source: sourceFor(input),
        attempt,
      });
      record.sourceHash = input.sha256;
      record.attemptHash = fileHash(path.join(root, `attempt-${assignment.label}.json`));
      write(`repair-${assignment.label}.json`, record);
      const row = {
        label: assignment.label,
        status: record.status,
        necessaryOnInput: record.necessaryOnInput,
        replays: record.rows.length,
      };
      records.push(row);
      console.log(JSON.stringify(row));
    }
    write("retention.json", {
      status: "complete",
      providerCalls: 0,
      records,
      explanation:
        "Exact-input repair evidence only. No generalized skill, fresh-case or recipient benefit established.",
    });
  } else throw Error("Unknown command");
}
