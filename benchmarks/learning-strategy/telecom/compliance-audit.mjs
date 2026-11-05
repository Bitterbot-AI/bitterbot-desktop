import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hash, usageCost } from "./provider.mjs";

const root = path.resolve(process.argv[2] ?? "");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const protocol = read("protocol.json"),
  freeze = read("freeze.json"),
  complete = read("complete.json");
assert.equal(protocol.kind, "telecom-public-observation-compliance");
assert.equal(hash(protocol), freeze.protocolHash);
const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telecom-compliance-replay-"));
const differences = [];
try {
  for (const source of freeze.sources) {
    const bytes = fs.readFileSync(path.join(root, source.snapshot));
    assert.equal(
      hash(bytes.toString("utf8")),
      source.sha256,
      `Changed snapshot: ${source.snapshot}`,
    );
    if (!fs.existsSync(source.file) || hash(fs.readFileSync(source.file, "utf8")) !== source.sha256)
      differences.push(source.file);
    const destination = path.resolve(replayRoot, source.file);
    assert.ok(destination.startsWith(replayRoot + path.sep));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  process.env.TAU_PYTHON ??= path.join(
    here,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const base = path.join(replayRoot, "benchmarks/learning-strategy/telecom");
  const { runEpisode } = await import(pathToFileURL(path.join(base, "episode.mjs")).href);
  const { summarizeCompliance } = await import(
    pathToFileURL(path.join(base, "compliance-report.mjs")).href
  );
  const ledger = fs
    .readFileSync(path.join(root, "provider.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const intents = ledger.filter((r) => r.type === "intent"),
    receipts = ledger.filter((r) => r.type === "receipt");
  assert.equal(intents.length, receipts.length, "Unresolved liability prevents complete audit");
  assert.equal(new Set(intents.map((r) => r.id)).size, intents.length);
  assert.equal(new Set(receipts.map((r) => r.id)).size, receipts.length);
  const receiptMap = new Map(receipts.map((r) => [r.id, r])),
    raw = new Map();
  let runningSpend = 0;
  for (const intent of intents) {
    const response = read(`responses/${intent.id}.json`),
      receipt = receiptMap.get(intent.id);
    assert.ok(receipt);
    assert.equal(response.status, 200);
    assert.equal(response.request.model, protocol.model);
    assert.equal(response.response.model, protocol.model);
    assert.equal(hash(response.request), intent.promptHash);
    assert.equal(usageCost(response.response.usage), receipt.usd);
    assert.deepEqual(response.response.usage, receipt.usage);
    assert.ok(receipt.usd <= intent.quote);
    assert.ok(
      runningSpend + intent.quote <= protocol.newSpendCapUsd + 1e-9,
      "Dispatch exceeded new-spend reservation cap",
    );
    runningSpend += receipt.usd;
    if (response.tag.split(":")[1] === "actor") {
      assert.ok(
        !JSON.stringify(response.request).includes(
          "Shareable diagnostic references (private until explicitly shared):",
        ),
        "Private reference metadata leaked to actor",
      );
      assert.ok(
        !JSON.stringify(response.request).includes("[PERSONA:"),
        "Hidden task marker leaked",
      );
    }
    raw.set(intent.id, response);
  }
  const expected = protocol.indices.map((index) => ({
    label: `conditional-0-${index}`,
    index,
    strategy: protocol.initialActor,
    reminders: protocol.reminders,
  }));
  assert.deepEqual(complete.executionManifest, expected);
  const used = new Set(),
    episodes = [];
  for (const entry of complete.executionManifest) {
    const episode = read(`episode-${entry.label}.json`),
      recorded = episode.transcript.filter((r) => r.id);
    let cursor = 0;
    const replay = await runEpisode({
      index: entry.index,
      strategy: entry.strategy,
      reminders: entry.reminders,
      tag: entry.label,
      maxCalls: protocol.maxCalls,
      maxUsd: protocol.perEpisodeUsd,
      conversationCache: protocol.conversationCache,
      observationMode: protocol.observationMode,
      provider: {
        async call(request, options) {
          if (cursor === recorded.length && episode.reason === "budget-limit")
            throw Error("Study provider ceiling reached");
          const row = recorded[cursor++];
          assert.ok(row, "Unrecorded response requested");
          const stored = raw.get(row.id),
            receipt = receiptMap.get(row.id);
          assert.ok(stored && receipt && !used.has(row.id));
          used.add(row.id);
          assert.deepEqual({ model: protocol.model, max_tokens: 1024, ...request }, stored.request);
          assert.equal(options.tag, stored.tag);
          assert.deepEqual(row.content, stored.response.content);
          return {
            id: row.id,
            usd: receipt.usd,
            wallMs: receipt.wallMs,
            content: stored.response.content,
            stopReason: stored.response.stop_reason,
          };
        },
      },
    });
    assert.equal(cursor, recorded.length);
    for (const key of ["verdict", "transcript", "publicConversation", "reason", "calls"])
      assert.deepEqual(replay[key], episode[key]);
    assert.equal(replay.cost.providerUsd, episode.cost.providerUsd);
    assert.equal(replay.cost.toolCalls, episode.cost.toolCalls);
    episodes.push({ label: entry.label, index: entry.index, episode });
  }
  assert.equal(used.size, receipts.length);
  const db = new DatabaseSync(path.join(root, "compliance.sqlite"), { readOnly: true });
  const runs = db.prepare("SELECT status,cost,passed FROM learning_runs").all();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "settled"));
  assert.equal(
    db.prepare("SELECT count(*) n FROM learning_runs WHERE partition!='held-out'").get().n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM strategy_proposals").get().n, 0);
  const seals = db.prepare("SELECT candidates FROM strategy_seals").all();
  assert.equal(seals.length, 1);
  assert.equal(JSON.parse(seals[0].candidates).length, 1);
  db.close();
  const paid = receipts.reduce((sum, r) => sum + r.usd, 0);
  assert.ok(
    Math.abs(runs.reduce((sum, r) => sum + JSON.parse(r.cost).providerUsd, 0) - paid) < 1e-9,
  );
  assert.ok(Math.abs(complete.evaluation.cost.providerUsd - paid) < 1e-9);
  assert.ok(Math.abs(complete.provider.spent - paid) < 1e-9);
  assert.equal(
    complete.evaluation.successes,
    episodes.filter(
      ({ episode }) =>
        episode.verdict.passed && ["user-ended", "human-transfer"].includes(episode.reason),
    ).length,
  );
  assert.equal(complete.provider.unresolved, 0);
  assert.equal(complete.provider.reserved, 0);
  const budget = read("project-budget.json"),
    prior = budget.priorExposure.reduce((sum, r) => sum + r.usd, 0);
  assert.equal(budget.ceiling, 15);
  assert.equal(budget.newSpendCapUsd, 1);
  assert.ok(paid <= 1 && prior + paid <= 15);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        sourceFiles: freeze.sources.length,
        workingTreeDifferences: differences,
        modelCalls: receipts.length,
        providerUsd: paid,
        priorExposureUsd: prior,
        cumulativeExposureUsd: prior + paid,
        remainingUsd: 15 - prior - paid,
        report: summarizeCompliance(episodes),
        narrativeReview: "pending; inspect public speech separately from validated typed records",
        note: "Every recorded request, publication, reminder, native tool action and verdict replayed from frozen sources. Model costs reconcile to provider and shadow SQLite. No new provider calls.",
      },
      null,
      2,
    ),
  );
} finally {
  assert.ok(path.resolve(replayRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(replayRoot, { recursive: true, force: true });
}
