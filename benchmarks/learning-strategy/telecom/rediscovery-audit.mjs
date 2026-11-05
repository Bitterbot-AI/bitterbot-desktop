import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { hash, usageCost } from "./provider.mjs";

const root = path.resolve(process.argv[2] ?? "");
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const p = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(p.kind, "telecom-autonomous-rediscovery");
assert.equal(hash(p), freeze.protocolHash);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rediscovery-replay-"));
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
const load = (name) =>
  import(pathToFileURL(path.join(temp, "benchmarks/learning-strategy/telecom", name)).href);
const { runEpisode } = await load("episode-recovery.mjs");
const { programProvider, executionInstructions } = await load("rediscovery-runtime.mjs");
const {
  feedbackRow,
  engineerPacket,
  diagnosisRequest,
  programRequest,
  parseResponse,
  parseProgram,
  diagnosticProbes,
} = await load("rediscovery-engineer.mjs");
const { ACTOR, selectCandidate, TRAINING, BRANCHES, NATURAL } = await load(
  "rediscovery-protocol.mjs",
);
const ledger = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const intents = ledger.filter((r) => r.type === "intent"),
  receipts = ledger.filter((r) => r.type === "receipt"),
  rm = new Map(receipts.map((r) => [r.id, r]));
assert.equal(new Set(intents.map((r) => r.id)).size, intents.length);
assert.equal(rm.size, receipts.length);
assert.equal(intents.length, receipts.length);
const raw = new Map();
for (const i of intents) {
  const r = read(`responses/${i.id}.json`),
    receipt = rm.get(i.id);
  assert.ok(receipt);
  assert.equal(r.status, 200);
  assert.equal(r.request.model, p.model);
  assert.equal(r.response.model, p.model);
  assert.equal(hash(r.request), i.promptHash);
  assert.deepEqual(r.response.usage, receipt.usage);
  assert.equal(usageCost(receipt.usage), receipt.usd);
  assert.ok(receipt.usd <= i.quote);
  raw.set(i.id, r);
}
const used = new Set(),
  ownership = new Map(),
  projections = [],
  episodes = [];
function response(id, request, tag, maxTokens, owner) {
  assert.ok(!used.has(id));
  used.add(id);
  ownership.set(id, owner);
  const r = raw.get(id),
    receipt = rm.get(id);
  assert.ok(r && receipt);
  assert.equal(r.tag, tag);
  assert.deepEqual({ model: p.model, max_tokens: maxTokens, ...request }, r.request);
  return {
    id,
    content: r.response.content,
    stopReason: r.response.stop_reason,
    usd: receipt.usd,
    wallMs: receipt.wallMs,
  };
}
async function replay(entry) {
  const original = read(`episode-${entry.label}.json`),
    calls = original.transcript.filter((r) => r.id);
  let cursor = 0;
  const e = await runEpisode({
    index: entry.index,
    strategy: executionInstructions(entry.actor),
    tag: entry.label,
    maxCalls: p.maxCalls,
    maxUsd: p.perEpisodeUsd,
    conversationCache: p.conversationCache,
    observationMode: p.observationMode,
    provider: programProvider(
      {
        call: async (request, options) => {
          if (cursor === calls.length && original.reason === "budget-limit")
            throw Error("Study provider ceiling reached");
          const call = calls[cursor++];
          assert.ok(call);
          return response(call.id, request, options.tag, 1024, entry.store);
        },
      },
      entry.actor,
      (event) => projections.push(event),
    ),
  });
  assert.equal(cursor, calls.length);
  for (const key of [
    "transcript",
    "publicConversation",
    "verdict",
    "reason",
    "publicationRecoveries",
  ])
    assert.deepEqual(e[key], original[key]);
  assert.equal(e.cost.providerUsd, original.cost.providerUsd);
  assert.equal(e.cost.toolCalls, original.cost.toolCalls);
  const row = {
    ...entry,
    passed: e.verdict.passed && NATURAL.includes(e.reason),
    termination: e.reason,
    modelCalls: calls.length,
    providerUsd: e.cost.providerUsd,
  };
  assert.deepEqual(
    row,
    complete.episodes.find((r) => r.label === entry.label),
  );
  episodes.push(row);
  return original;
}
const selected = [];
if (p.stage === "discovery") {
  for (const branchName of BRANCHES) {
    const branch = branchName.startsWith("experience") ? "experience" : "blind";
    const bank = new Map(read("initial-history.json").map((r) => [r.case, r]));
    let parentActor = ACTOR;
    const candidates = [];
    const db = new DatabaseSync(path.join(root, `${branchName}.sqlite`), { readOnly: true });
    try {
      for (let round = 0; round < p.rounds; round++) {
        const label = `${branchName}-r${round}`,
          recorded = read(`proposal-${label}.json`),
          row = read(`round-${label}.json`);
        const feedback = TRAINING.map((_, i) =>
          branch === "experience"
            ? JSON.stringify(feedbackRow(bank.get(`case-${i}`).episode, `case-${i}`))
            : "Execution feedback withheld.",
        );
        const packet = engineerPacket({
          branch,
          round,
          actor: parentActor,
          feedback,
          context: read("engineer-context.json"),
        });
        assert.deepEqual(packet, recorded.packet);
        const diagnostic = response(
          recorded.diagnosisId,
          diagnosisRequest(packet),
          `${label}:diagnosis`,
          2048,
          branchName,
        );
        let diagnosis;
        try {
          diagnosis = parseResponse(diagnostic);
        } catch (error) {
          diagnosis = { hypotheses: `Invalid diagnostic plan: ${error.message}`, probes: [] };
        }
        assert.deepEqual(diagnosis, recorded.diagnosis);
        const probes = await diagnosticProbes(diagnosis, branch, bank);
        assert.deepEqual(probes, recorded.probeResults);
        const generatedResponse = response(
          recorded.programId,
          programRequest(packet, diagnosis, probes),
          `${label}:program`,
          4096,
          branchName,
        );
        const generated = parseProgram(generatedResponse);
        assert.deepEqual(generated, recorded.generated);
        assert.equal(row.actor, generated.valid ? generated.actor : ACTOR);
        assert.equal(row.valid, generated.valid);
        assert.ok(Math.abs(recorded.providerUsd - diagnostic.usd - generatedResponse.usd) < 1e-9);
        const stored = db.prepare("SELECT body FROM strategy_entries WHERE hash=?").get(row.hash);
        assert.ok(stored);
        const body = JSON.parse(stored.body);
        assert.equal(body.actor, row.actor);
        assert.deepEqual(body.parents, [recorded.parent]);
        const proposal = db
          .prepare("SELECT parent FROM strategy_proposals WHERE child=?")
          .get(row.hash);
        assert.equal(proposal.parent, recorded.parent);
        for (const [i, index] of TRAINING.entries()) {
          const caseId = `case-${i}`,
            entry = {
              label: `${label}-case-${index}`,
              branch: branchName,
              round,
              index,
              case: caseId,
              actor: row.actor,
              store: branchName,
            };
          bank.set(caseId, { index, episode: await replay(entry) });
        }
        const group = episodes.filter((e) => e.branch === branchName && e.round === round);
        assert.equal(row.successes, group.filter((e) => e.passed).length);
        assert.equal(
          row.modelCalls,
          group.reduce((s, e) => s + e.modelCalls, 0),
        );
        candidates.push(row);
        parentActor = row.actor;
      }
      const winner = selectCandidate(candidates),
        saved = read(`selection-${branchName}.json`);
      assert.deepEqual(saved.candidates, candidates);
      if (winner)
        for (const key of ["hash", "actor", "round", "valid", "successes", "modelCalls"])
          assert.deepEqual(saved[key], winner[key]);
      else {
        assert.equal(saved.valid, false);
        assert.equal(saved.actor, ACTOR);
      }
      assert.deepEqual(
        JSON.parse(db.prepare("SELECT candidates FROM strategy_seals").get().candidates),
        [saved.hash],
      );
      selected.push(saved);
    } finally {
      db.close();
    }
  }
  assert.deepEqual(selected, complete.selections);
  const nominees = selected
    .filter((s) => s.branch.startsWith("experience") && s.valid)
    .toSorted(
      (a, b) => b.successes - a.successes || a.modelCalls - b.modelCalls || a.round - b.round,
    );
  assert.equal(complete.nominated, nominees[0]?.branch ?? null);
  assert.equal(complete.proposalLabels.length, 12);
} else {
  for (const block of p.schedule)
    for (const index of block.indices) {
      const store = `${block.arm}-${block.repetition}`;
      await replay({
        label: `${store}-${index}`,
        arm: block.arm,
        repetition: block.repetition,
        index,
        actor: p.actors[block.arm],
        store,
      });
    }
}
assert.equal(episodes.length, p.newEvaluationEpisodes);
assert.equal(complete.episodes.length, episodes.length);
assert.equal(new Set(episodes.map((e) => e.label)).size, episodes.length);
assert.equal(used.size, receipts.length);
const recordedProjections = fs.existsSync(path.join(root, "program-events.jsonl"))
  ? fs
      .readFileSync(path.join(root, "program-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
  : [];
const order = (rows) => [...rows].sort((a, b) => a.tag.localeCompare(b.tag));
assert.deepEqual(order(projections), order(recordedProjections));
assert.equal(new Set(recordedProjections.map((r) => r.tag)).size, projections.length);
let sqlUsd = 0,
  sqlRuns = 0;
for (const name of new Set(episodes.map((e) => e.store))) {
  const db = new DatabaseSync(path.join(root, name + ".sqlite"), { readOnly: true });
  try {
    const runs = db.prepare("SELECT * FROM learning_runs").all();
    assert.ok(runs.every((r) => r.status === "settled" && r.cost));
    assert.equal(runs.length, p.stage === "discovery" ? 27 : p.indices.length);
    sqlRuns += runs.length;
    sqlUsd += runs.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM strategy_proposals").get().n,
      p.stage === "discovery" ? p.rounds : 0,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM strategy_seals").get().n, 1);
    const batches = db
      .prepare("SELECT result FROM strategy_batches")
      .all()
      .map((r) => JSON.parse(r.result));
    assert.equal(batches.length, p.stage === "discovery" ? p.rounds + 1 : 1);
    if (p.stage !== "discovery")
      assert.equal(
        batches[0].successes,
        episodes.filter((e) => e.store === name && e.passed).length,
      );
  } finally {
    db.close();
  }
}
const lanes = new Map(),
  active = new Set();
let peakConcurrent = 0;
for (const event of ledger) {
  const owner = ownership.get(event.id);
  assert.ok(owner);
  if (!lanes.has(owner)) lanes.set(owner, { spent: 0, active: null });
  const lane = lanes.get(owner);
  if (event.type === "intent") {
    assert.equal(lane.active, null);
    assert.ok(lane.spent + event.quote <= p.laneCeilingUsd + 1e-9);
    lane.active = event.id;
    active.add(owner);
    peakConcurrent = Math.max(peakConcurrent, active.size);
  } else if (event.type === "receipt") {
    assert.equal(lane.active, event.id);
    lane.spent += event.usd;
    lane.active = null;
    active.delete(owner);
  } else throw Error("Unsettled provider event");
}
assert.equal(active.size, 0);
assert.ok(peakConcurrent <= p.concurrency);
const paid = receipts.reduce((s, r) => s + r.usd, 0),
  budget = read("project-budget.json");
assert.ok(Math.abs(paid - sqlUsd) < 1e-9);
assert.ok(Math.abs(paid - complete.provider.spent) < 1e-9);
assert.equal(complete.provider.unresolved, 0);
assert.equal(complete.provider.reserved, 0);
assert.ok(
  Math.abs(budget.priorExposure.reduce((s, r) => s + r.usd, 0) - complete.priorExposureUsd) < 1e-9,
);
console.log(
  JSON.stringify(
    {
      status: "passed",
      stage: p.stage,
      sourceFiles: freeze.sources.length,
      episodes,
      modelCalls: receipts.length,
      sqlRuns,
      programProjectionsReplayed: projections.length,
      peakConcurrent,
      providerUsd: paid,
      cumulativeExposureUsd: complete.priorExposureUsd + paid,
      engineerCalls: p.stage === "discovery" ? 24 : 0,
      note: "Cold reconstruction of frozen runtime, exact episode and engineer requests, native diagnostic probe replay, hidden-feedback control, candidate selection, SQLite and provider accounting. No new provider calls.",
    },
    null,
    2,
  ),
);
