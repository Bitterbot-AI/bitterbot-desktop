import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hash, usageCost } from "./rediscovery2-provider.mjs";

const root = path.resolve(process.argv[2] ?? ""),
  read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const p = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(p.kind, "telecom-failure-engineered-repair-controller");
assert.equal(hash(p), freeze.protocolHash);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "repair-learning-replay-"));
process.once("exit", () => {
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, { recursive: true, force: true });
});
for (const s of freeze.sources) {
  const bytes = fs.readFileSync(path.join(root, s.snapshot));
  assert.equal(hash(bytes.toString("utf8")), s.sha256);
  const target = path.resolve(temp, s.file);
  assert.ok(target.startsWith(temp + path.sep));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
process.env.TAU_PYTHON ??= path.resolve(
  "benchmarks/learning-strategy/telecom/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const {
  CONDITIONS,
  generateController,
  runControllerAttempt,
  summarizeLearning,
  verifyControllerSequence,
} = await import(
  pathToFileURL(path.join(temp, "benchmarks/learning-strategy/telecom/repair-learning-runtime.mjs"))
    .href
);
assert.equal(
  hash(fs.readFileSync(path.join(root, "learning-evidence.json"), "utf8")),
  p.evidenceHash,
);
assert.equal(hash(fs.readFileSync(path.join(root, "public-context.json"), "utf8")), p.contextHash);
const ledger = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const intents = ledger.filter((r) => r.type === "intent"),
  receipts = ledger.filter((r) => r.type === "receipt"),
  rm = new Map(receipts.map((r) => [r.id, r]));
assert.equal(new Set(intents.map((i) => i.id)).size, intents.length);
assert.equal(rm.size, receipts.length);
assert.equal(intents.length, receipts.length);
const raws = new Map();
for (const intent of intents) {
  const raw = read(`responses/${intent.id}.json`),
    receipt = rm.get(intent.id);
  assert.ok(receipt);
  assert.equal(raw.status, 200);
  assert.equal(raw.request.model, p.model);
  assert.equal(raw.response.model, p.model);
  assert.equal(raw.tag, intent.tag);
  assert.equal(receipt.tag, intent.tag);
  assert.equal(hash(raw.request), intent.promptHash);
  assert.deepEqual(raw.response.usage, receipt.usage);
  assert.equal(usageCost(receipt.usage), receipt.usd);
  assert.ok(receipt.usd <= intent.quote);
  assert.equal(raw.response.stop_reason, receipt.stopReason);
  raws.set(intent.id, raw);
}
const used = new Set();
function replayProvider(ids) {
  let cursor = 0;
  return {
    done: () => assert.equal(cursor, ids.length),
    call: async (request, { tag, maxTokens }) => {
      const id = ids[cursor++];
      assert.ok(id);
      assert.ok(!used.has(id));
      used.add(id);
      const raw = raws.get(id),
        receipt = rm.get(id);
      assert.ok(raw && receipt);
      assert.equal(raw.tag, tag);
      assert.deepEqual({ model: p.model, max_tokens: maxTokens, ...request }, raw.request);
      return {
        id,
        usd: receipt.usd,
        wallMs: receipt.wallMs,
        content: raw.response.content,
        stopReason: raw.response.stop_reason,
      };
    },
  };
}
const controllers = [];
for (const arm of CONDITIONS) {
  const original = read(`generation-${arm}.json`),
    provider = replayProvider(original.attempts.map((a) => a.id));
  const generation = await generateController(
    provider,
    arm,
    read("public-context.json"),
    read("learning-evidence.json"),
  );
  provider.done();
  assert.deepEqual(generation, original);
  controllers.push({
    arm,
    valid: generation.generated.valid,
    instructions: generation.generated.valid ? generation.generated.program.instructions : "",
    generationUsd: generation.usd,
  });
}
assert.deepEqual(read("controllers.json"), {
  controllers,
  generationCompleteBeforeEvaluation: true,
});
assert.equal(
  hash(fs.readFileSync(path.join(root, "controllers.json"), "utf8")),
  complete.controllerHash,
);
const lastGenerationReceipt = Math.max(
  ...receipts.filter((r) => r.tag.startsWith("repair-controller-")).map((r) => Date.parse(r.at)),
);
const firstEvaluationIntent = Math.min(
  ...intents.filter((r) => !r.tag.startsWith("repair-controller-")).map((r) => Date.parse(r.at)),
);
assert.ok(
  lastGenerationReceipt <= firstEvaluationIntent,
  "Evaluation started before both generators finished",
);
const attempts = [],
  repairRecords = [];
let nativeActions = 0,
  verificationReplays = 0;
for (const assignment of p.assignments) {
  const input = p.inputs.find((i) => i.index === assignment.index),
    bytes = fs.readFileSync(path.join(root, input.input), "utf8");
  assert.equal(hash(bytes), input.sha256);
  const source = { index: input.index, episode: JSON.parse(bytes) },
    original = read(`attempt-${assignment.label}.json`),
    provider = replayProvider(original.calls.map((c) => c.id));
  const replayed = await runControllerAttempt({
    assignment,
    source,
    controller: controllers.find((c) => c.arm === assignment.arm).instructions,
    provider,
  });
  provider.done();
  assert.deepEqual(replayed, original);
  nativeActions += replayed.result.nativeActions;
  attempts.push(replayed);
  if (replayed.result.afterPassed === true) {
    const record = await verifyControllerSequence({ assignment, source, attempt: replayed });
    record.sourceHash = input.sha256;
    record.attemptHash = hash(
      fs.readFileSync(path.join(root, `attempt-${assignment.label}.json`), "utf8"),
    );
    assert.deepEqual(record, read(`repair-${assignment.label}.json`));
    verificationReplays += record.rows.length;
    repairRecords.push({
      label: assignment.label,
      status: record.status,
      necessaryOnInput: record.necessaryOnInput,
      replays: record.rows.length,
    });
  }
  console.log(JSON.stringify({ replayed: assignment.label, passed: replayed.result.afterPassed }));
}
assert.equal(used.size, receipts.length);
assert.deepEqual(complete.assignments, p.assignments);
const summary = summarizeLearning(p.assignments, attempts);
summary.gatePassed &&= controllers.every((c) => c.valid);
assert.deepEqual(summary, complete.summary);
assert.deepEqual(repairRecords, read("retention.json").records);
const usd = receipts.reduce((s, r) => s + r.usd, 0),
  completedUsd = complete.provider.reduce((s, r) => s + r.spent, 0);
assert.ok(Math.abs(usd - completedUsd) < 1e-9);
assert.ok(complete.provider.every((r) => !r.active && r.unresolved === 0 && r.reserved === 0));
const report = {
  status: "passed",
  protocolHash: freeze.protocolHash,
  completeHash: hash(fs.readFileSync(path.join(root, "complete.json"), "utf8")),
  assignments: attempts.length,
  exactProviderRequests: used.size,
  nativeActions,
  verificationReplays,
  verifiedRepairRecords: repairRecords.filter((r) => r.status === "verified").length,
  providerUsd: usd,
  note: "Cold reconstruction from frozen sources, exact generation and evaluation requests/usage, native transitions, controller seal before evaluation, all omission replays. Integrity is not an efficacy claim.",
};
fs.writeFileSync(path.join(root, "audit.json"), JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify(report));
