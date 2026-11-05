import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hash, usageCost } from "./rediscovery2-provider.mjs";

const root = path.resolve(process.argv[2] ?? ""),
  read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8")),
  fileHash = (f) => hash(fs.readFileSync(f, "utf8"));
const p = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(p.kind, "telecom-guarded-procedure-reuse");
assert.equal(hash(p), freeze.protocolHash);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "guarded-procedure-replay-"));
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
  generateProcedure,
  runGuardedAttempt,
  summarizeGuarded,
  panelSummary,
  qualificationGate,
  retainedEvidence,
} = await import(
  pathToFileURL(
    path.join(temp, "benchmarks/learning-strategy/telecom/guarded-procedure-runtime.mjs"),
  ).href
);
assert.equal(fileHash(path.join(root, "learning-evidence.json")), p.evidenceHash);
assert.equal(fileHash(path.join(root, "public-context.json")), p.contextHash);
const parent = path.join(path.dirname(root), p.sourceRun),
  readParent = (n) => JSON.parse(fs.readFileSync(path.join(parent, n), "utf8"));
assert.equal(fileHash(path.join(parent, "audit.json")), p.sourceAuditHash);
assert.equal(readParent("audit.json").status, "passed");
const pp = readParent("protocol.json"),
  context = read("public-context.json"),
  evidence = read("learning-evidence.json");
assert.deepEqual(
  retainedEvidence(
    p.inputs.map((i) => ({ alias: i.alias, episode: read(i.input) })),
    pp.assignments.map((a) => readParent(`attempt-${a.label}.json`)),
    readParent("retention.json").records.map((r) => readParent(`repair-${r.label}.json`)),
  ),
  evidence,
);
const discovery = path.join(path.dirname(root), p.panelSourceRun),
  dc = JSON.parse(fs.readFileSync(path.join(discovery, "complete.json"), "utf8")),
  primaryHashes = new Set(p.inputs.map((i) => i.sha256));
const expectedPanel = dc.episodes
  .filter((a) => p.inputs.some((i) => i.index === a.index))
  .filter((a) => !primaryHashes.has(fileHash(path.join(discovery, `episode-${a.label}.json`))))
  .map((a) => a.label);
assert.deepEqual(
  p.panelInputs.map((i) => i.parent),
  expectedPanel,
);
for (const i of p.panelInputs)
  assert.equal(fileHash(path.join(discovery, `episode-${i.parent}.json`)), i.sha256);
assert.ok([...p.inputs, ...p.panelInputs].every((i) => !p.reservedRecipients.includes(i.index)));
const ledger = fs
    .readFileSync(path.join(root, "provider.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse),
  intents = ledger.filter((r) => r.type === "intent"),
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
const artifacts = [];
for (const candidate of p.candidates) {
  const original = read(`generation-${candidate}.json`),
    provider = replayProvider(original.calls.map((c) => c.id));
  const generated = await generateProcedure(provider, candidate, context, evidence);
  provider.done();
  assert.deepEqual(generated, original);
  artifacts.push({
    candidate,
    valid: generated.valid,
    procedure: generated.procedure,
    generationUsd: generated.calls.reduce((s, c) => s + c.usd, 0),
  });
}
assert.deepEqual(read("artifacts.json"), { artifacts, generationCompleteBeforeEvaluation: true });
assert.equal(fileHash(path.join(root, "artifacts.json")), complete.artifactHash);
const generationTag = (tag) => p.candidates.some((c) => tag.startsWith(c + ":procedure-"));
assert.ok(
  Math.max(...receipts.filter((r) => generationTag(r.tag)).map((r) => Date.parse(r.at))) <=
    Math.min(...intents.filter((r) => !generationTag(r.tag)).map((r) => Date.parse(r.at))),
);
const attempts = [];
let nativeActions = 0;
for (const assignment of [...p.assignments, ...p.panelAssignments]) {
  const input = [...p.inputs, ...p.panelInputs].find((i) => i.alias === assignment.alias);
  assert.equal(fileHash(path.join(root, input.input)), input.sha256);
  const original = read(`attempt-${assignment.label}.json`),
    provider = replayProvider(original.calls.map((c) => c.id));
  const replayed = await runGuardedAttempt({
    assignment,
    source: { index: input.index, episode: read(input.input) },
    artifact: artifacts.find((a) => a.candidate === assignment.candidate)?.procedure,
    evidence,
    provider,
    context,
  });
  provider.done();
  assert.deepEqual(replayed, original);
  attempts.push(replayed);
  nativeActions += replayed.result.nativeActions;
  console.log(JSON.stringify({ replayed: assignment.label, passed: replayed.result.afterPassed }));
}
assert.equal(used.size, receipts.length);
const summary = summarizeGuarded(
    p.assignments,
    attempts.filter((a) => a.assignment.scope === "primary"),
  ),
  panel = panelSummary(
    p.panelAssignments,
    attempts.filter((a) => a.assignment.scope === "panel"),
    context,
  );
assert.deepEqual(summary, complete.summary);
assert.deepEqual(panel, complete.panel);
assert.equal(qualificationGate(artifacts, summary, panel), complete.gatePassed);
const usd = receipts.reduce((s, r) => s + r.usd, 0);
assert.ok(Math.abs(usd - complete.provider.reduce((s, r) => s + r.spent, 0)) < 1e-9);
assert.ok(complete.provider.every((r) => !r.active && r.unresolved === 0 && r.reserved === 0));
assert.ok(Math.abs(complete.cumulativeExposureUsd - complete.priorExposureUsd - usd) < 1e-9);
const report = {
  status: "passed",
  protocolHash: freeze.protocolHash,
  completeHash: fileHash(path.join(root, "complete.json")),
  assignments: attempts.length,
  exactProviderRequests: used.size,
  nativeActions,
  providerUsd: usd,
  gatePassed: complete.gatePassed,
  note: "Cold reconstruction from frozen sources: all generated artifacts, exact requests/receipts, native transitions, primary and full additional-state denominators. Repeated runs are not independent cases. Integrity is not efficacy.",
};
const auditPath = path.join(root, "audit.json");
if (fs.existsSync(auditPath)) {
  // Replaying published evidence must not overwrite its original integrity record.
  assert.deepEqual(read("audit.json"), report);
} else {
  fs.writeFileSync(auditPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify(report));
