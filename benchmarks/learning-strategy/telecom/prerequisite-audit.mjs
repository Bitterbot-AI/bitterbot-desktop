import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { hash, usageCost } from "./provider.mjs";

const root = path.resolve(process.argv[2] ?? "");
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const protocol = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(protocol.kind, "telecom-prerequisite-comparison");
assert.equal(hash(protocol), freeze.protocolHash);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "procedure-replay-"));
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
const { runEpisode } = await import(
  pathToFileURL(path.join(temp, "benchmarks/learning-strategy/telecom/episode.mjs")).href
);
const { prerequisiteProvider } = await import(
  pathToFileURL(path.join(temp, "benchmarks/learning-strategy/telecom/prerequisite-ledger.mjs"))
    .href
);
const recordedLedger = fs.existsSync(path.join(root, "ledger-events.jsonl"))
  ? fs
      .readFileSync(path.join(root, "ledger-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
  : [];
const replayedLedger = [];
const ledger = fs
    .readFileSync(path.join(root, "provider.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse),
  intents = ledger.filter((r) => r.type === "intent"),
  receipts = ledger.filter((r) => r.type === "receipt");
assert.equal(new Set(intents.map((r) => r.id)).size, intents.length);
assert.equal(new Set(receipts.map((r) => r.id)).size, receipts.length);
assert.equal(intents.length, receipts.length);
const raw = new Map(),
  rm = new Map(receipts.map((r) => [r.id, r]));
for (const i of intents) {
  const r = read(`responses/${i.id}.json`),
    receipt = rm.get(i.id);
  assert.ok(receipt);
  assert.equal(r.status, 200);
  assert.equal(r.request.model, protocol.model);
  assert.equal(r.response.model, protocol.model);
  assert.equal(hash(r.request), i.promptHash);
  assert.deepEqual(receipt.usage, r.response.usage);
  assert.equal(usageCost(receipt.usage), receipt.usd);
  assert.ok(receipt.usd <= i.quote);
  assert.ok(!JSON.stringify(r.request).includes("[PERSONA:"));
  raw.set(i.id, r);
}
const assigned = protocol.schedule.flatMap((b) =>
  b.indices.map((index) => ({
    label: `${b.arm}-${b.repetition}-${index}`,
    index,
    arm: b.arm,
    repetition: b.repetition,
    strategy: protocol.actors[b.arm],
  })),
);
assert.deepEqual(complete.executionManifest, assigned);
const used = new Set(),
  episodes = [];
for (const entry of assigned) {
  const original = read(`episode-${entry.label}.json`),
    responses = original.transcript.filter((r) => r.id);
  let cursor = 0;
  const replay = await runEpisode({
    index: entry.index,
    strategy: entry.strategy,
    tag: entry.label,
    maxCalls: protocol.maxCalls,
    maxUsd: protocol.perEpisodeUsd,
    conversationCache: protocol.conversationCache,
    observationMode: protocol.observationMode,
    provider: prerequisiteProvider(
      {
        call: async (request, options) => {
          if (cursor === responses.length && original.reason === "budget-limit")
            throw Error("Study provider ceiling reached");
          const response = responses[cursor++];
          assert.ok(response);
          assert.ok(!used.has(response.id));
          used.add(response.id);
          const r = raw.get(response.id),
            receipt = rm.get(response.id);
          assert.ok(r && receipt);
          assert.deepEqual({ model: protocol.model, max_tokens: 1024, ...request }, r.request);
          assert.equal(options.tag, r.tag);
          assert.deepEqual(response.content, r.response.content);
          return {
            id: response.id,
            content: r.response.content,
            stopReason: r.response.stop_reason,
            usd: receipt.usd,
            wallMs: receipt.wallMs,
          };
        },
      },
      entry.arm,
      (event) => replayedLedger.push(event),
    ),
  });
  assert.equal(cursor, responses.length);
  for (const key of ["verdict", "transcript", "publicConversation", "reason"])
    assert.deepEqual(replay[key], original[key]);
  assert.equal(replay.cost.providerUsd, original.cost.providerUsd);
  assert.equal(replay.cost.toolCalls, original.cost.toolCalls);
  episodes.push({
    ...entry,
    passed: original.verdict.passed && ["user-ended", "human-transfer"].includes(original.reason),
    termination: original.reason,
    modelCalls: responses.length,
    toolCalls: original.cost.toolCalls,
    providerUsd: original.cost.providerUsd,
  });
}
assert.equal(used.size, receipts.length);
let sqlUsd = 0,
  sqlRuns = 0;
for (const block of protocol.schedule) {
  const db = new DatabaseSync(path.join(root, block.store + ".sqlite"), { readOnly: true });
  const rows = db.prepare("SELECT status,cost,passed,partition FROM learning_runs").all();
  assert.equal(rows.length, block.indices.length);
  assert.ok(rows.every((r) => r.status === "settled"));
  assert.ok(
    rows.every(
      (r) => r.partition === (protocol.partition === "development" ? "acquisition" : "held-out"),
    ),
  );
  assert.equal(db.prepare("SELECT count(*) n FROM strategy_proposals").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM strategy_seals").get().n, 1);
  const batch = db.prepare("SELECT result FROM strategy_batches").get();
  assert.ok(batch);
  const result = JSON.parse(batch.result),
    group = episodes.filter((e) => e.arm === block.arm && e.repetition === block.repetition);
  assert.equal(result.successes, group.filter((e) => e.passed).length);
  assert.equal(result.total, group.length);
  assert.ok(
    Math.abs(result.cost.providerUsd - group.reduce((s, e) => s + e.providerUsd, 0)) < 1e-9,
  );
  sqlRuns += rows.length;
  sqlUsd += rows.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0);
  db.close();
}
assert.equal(sqlRuns, assigned.length);
const paid = receipts.reduce((s, r) => s + r.usd, 0);
assert.ok(Math.abs(sqlUsd - paid) < 1e-9);
assert.ok(Math.abs(complete.provider.spent - paid) < 1e-9);
const assignmentRows = fs
  .readFileSync(path.join(root, "lanes.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
assert.equal(new Set(assignmentRows.map((r) => r.store)).size, protocol.schedule.length);
const lanes = Array.from({ length: protocol.concurrency }, () => ({
    spent: 0,
    reserved: 0,
    active: null,
  })),
  laneByStore = new Map(assignmentRows.map((r) => [r.store, r.lane])),
  active = new Map();
let peakConcurrent = 0;
for (const row of ledger) {
  if (row.type === "intent") {
    const label = row.tag.split(":")[0],
      store = label.slice(0, label.lastIndexOf("-")),
      lane = laneByStore.get(store),
      s = lanes[lane];
    assert.ok(s);
    assert.equal(s.active, null);
    assert.ok(s.spent + row.quote <= protocol.laneCeilingUsd + 1e-9);
    s.active = row.id;
    s.reserved = row.quote;
    active.set(row.id, lane);
    peakConcurrent = Math.max(peakConcurrent, active.size);
  } else if (row.type === "receipt") {
    const s = lanes[active.get(row.id)];
    assert.ok(s);
    assert.equal(s.active, row.id);
    s.spent += row.usd;
    s.reserved = 0;
    s.active = null;
    active.delete(row.id);
  } else throw Error("Unsettled ledger event");
  assert.ok(
    lanes.reduce((s, l) => s + l.spent + l.reserved, 0) <=
      protocol.newSpendCircuitBreakerUsd + 1e-9,
  );
}
assert.equal(active.size, 0);
assert.ok(peakConcurrent <= protocol.concurrency);
const order = (rows) => [...rows].sort((a, b) => a.tag.localeCompare(b.tag));
assert.deepEqual(order(replayedLedger), order(recordedLedger));
assert.equal(new Set(recordedLedger.map((r) => r.tag)).size, recordedLedger.length);
const budget = read("project-budget.json"),
  prior = budget.priorExposure.reduce((s, r) => s + r.usd, 0);
assert.ok(prior + paid <= budget.ceiling);
console.log(
  JSON.stringify(
    {
      status: "passed",
      sourceFiles: freeze.sources.length,
      modelCalls: receipts.length,
      episodes,
      providerUsd: paid,
      priorExposureUsd: prior,
      cumulativeExposureUsd: prior + paid,
      laneAudit: { status: "passed", peakConcurrent, lanes },
      ledgerSnapshotsReplayed: replayedLedger.length,
      note: "Frozen exact request/response/native replay, all assigned outcomes and SQLite/provider accounting. No new provider calls.",
    },
    null,
    2,
  ),
);
