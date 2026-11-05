import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { hash, usageCost } from "./rediscovery2-provider.mjs";

const root = path.resolve(process.argv[2] ?? ""),
  read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const p = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(p.kind, "telecom-interactive-repair-discovery");
assert.equal(hash(p), freeze.protocolHash);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-repair-replay-"));
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
const { runRepairAttempt, summarizeRepairs, verifyRepairSequence } = await import(
  pathToFileURL(
    path.join(temp, "benchmarks/learning-strategy/telecom/interactive-repair2-runtime.mjs"),
  ).href
);
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
const used = new Set(),
  attempts = [],
  repairRecords = [];
let nativeActions = 0,
  verificationReplays = 0;
for (const assignment of p.assignments) {
  const input = p.inputs.find((i) => i.index === assignment.index),
    bytes = fs.readFileSync(path.join(root, input.input), "utf8");
  assert.equal(hash(bytes), input.sha256);
  const source = { index: input.index, episode: JSON.parse(bytes) },
    original = read(`attempt-${assignment.label}.json`);
  let cursor = 0;
  const replayed = await runRepairAttempt({
    assignment,
    source,
    provider: {
      call: async (request, { tag, maxTokens }) => {
        const recorded = original.calls[cursor++];
        assert.ok(recorded);
        assert.ok(!used.has(recorded.id));
        used.add(recorded.id);
        const raw = raws.get(recorded.id),
          receipt = rm.get(recorded.id);
        assert.ok(raw && receipt);
        assert.equal(raw.tag, tag);
        assert.deepEqual({ model: p.model, max_tokens: maxTokens, ...request }, raw.request);
        return {
          id: recorded.id,
          usd: receipt.usd,
          wallMs: receipt.wallMs,
          content: raw.response.content,
          stopReason: raw.response.stop_reason,
        };
      },
    },
  });
  assert.equal(cursor, original.calls.length);
  assert.deepEqual(replayed, original);
  nativeActions += replayed.result.nativeActions;
  attempts.push(replayed);
  if (replayed.result.afterPassed === true && fs.existsSync(path.join(root, "retention.json"))) {
    const record = await verifyRepairSequence({ assignment, source, attempt: replayed });
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

// Completion order changed only the presentation order of case rows in the frozen collector.
// Compare every stored value after sorting those rows by case identity, then independently
// recompute the gate by case identity. Original complete.json and frozen sources stay unchanged.
const normalize = value => {
  const clone = structuredClone(value);
  for (const arm of clone.arms) arm.cases.sort((a,b)=>a.index-b.index);
  return clone;
};
const reconstructed = normalize(summarizeRepairs(p.assignments, attempts));
assert.deepEqual(reconstructed, normalize(complete.summary));
const [batch, interactive] = reconstructed.arms;
const independentGate = reconstructed.arms.every(a=>a.errors===0) && interactive.repaired>=batch.repaired+3 && interactive.cases.every(c=>c.repaired>=batch.cases.find(b=>b.index===c.index).repaired);
assert.equal(independentGate, complete.summary.mechanismGatePassed);

const usd = receipts.reduce((s, r) => s + r.usd, 0),
  completedUsd = complete.provider.reduce((s, r) => s + r.spent, 0);
assert.ok(Math.abs(usd - completedUsd) < 1e-9);
assert.ok(complete.provider.every((r) => !r.active && r.unresolved === 0 && r.reserved === 0));
if (fs.existsSync(path.join(root, "retention.json")))
  assert.deepEqual(repairRecords, read("retention.json").records);
const audit = {
  status: "passed",
  auditorRevision: "case-identity-normalization-v3",
  auditorHash: hash(fs.readFileSync(fileURLToPath(import.meta.url), "utf8")),
  protocolHash: freeze.protocolHash,
  completeHash: hash(fs.readFileSync(path.join(root, "complete.json"), "utf8")),
  assignments: attempts.length,
  exactProviderRequests: used.size,
  nativeActions,
  verificationReplays,
  verifiedRepairRecords: repairRecords.filter((r) => r.status === "verified").length,
  providerUsd: usd,
  note: "Cold replay from frozen sources, exact model requests/responses/usage and native transitions. Audit success verifies integrity, not a positive learning effect.",
};
fs.writeFileSync(path.join(root, "audit.json"), JSON.stringify(audit, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify(audit));
