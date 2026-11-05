import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
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
const learning = protocol.kind === "telecom-single-correction-transfer";
const conditional = protocol.kind === "telecom-conditional-reminder-comparison";
assert.equal(hash(protocol), freeze.protocolHash);
const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tau-frozen-replay-"));
process.once("exit", () => {
  assert.ok(path.resolve(replayRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(replayRoot, { recursive: true, force: true });
});
const currentDifferences = [];
for (const source of freeze.sources) {
  const bytes = fs.readFileSync(path.join(root, source.snapshot));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    source.sha256,
    `Changed frozen source: ${source.snapshot}`,
  );
  if (
    !fs.existsSync(source.file) ||
    createHash("sha256").update(fs.readFileSync(source.file)).digest("hex") !== source.sha256
  )
    currentDifferences.push(source.file);
  const target = path.resolve(replayRoot, source.file);
  assert.ok(target.startsWith(replayRoot + path.sep), "Source path escapes replay directory");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.TAU_PYTHON ??= path.join(
  here,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const { runEpisode } = await import(
  pathToFileURL(path.join(replayRoot, "benchmarks/learning-strategy/telecom/episode.mjs")).href
);
const { createBridge } = await import(
  pathToFileURL(path.join(replayRoot, "benchmarks/learning-strategy/telecom/bridge.mjs")).href
);
const ledger = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const intents = ledger.filter((r) => r.type === "intent"),
  receipts = ledger.filter((r) => r.type === "receipt");
assert.equal(new Set(intents.map((r) => r.id)).size, intents.length);
assert.equal(new Set(receipts.map((r) => r.id)).size, receipts.length);
assert.equal(intents.length, receipts.length);
const raw = new Map(),
  receiptMap = new Map(receipts.map((r) => [r.id, r]));
for (const intent of intents) {
  const response = read(`responses/${intent.id}.json`),
    receipt = receiptMap.get(intent.id);
  assert.ok(receipt);
  assert.equal(response.status, 200);
  assert.equal(response.response.model, protocol.model);
  assert.equal(response.request.model, protocol.model);
  assert.equal(hash(response.request), intent.promptHash);
  assert.equal(usageCost(response.response.usage), receipt.usd);
  assert.deepEqual(response.response.usage, receipt.usage);
  assert.ok(receipt.usd <= intent.quote);
  assert.ok(!JSON.stringify(response.request).includes("[PERSONA:"), "Hidden task ID leaked");
  raw.set(intent.id, response);
}
const used = new Set(),
  summaries = [];
const manifest =
  learning || conditional
    ? complete.executionManifest
    : protocol.indices.map((index) => ({
        index,
        label: String(index),
        strategy: protocol.initialActor,
        tag: `pilot-${index}`,
      }));
assert.equal(new Set(manifest.map((e) => e.label)).size, manifest.length);
for (const { index, label, strategy, reminders = [], tag = label } of manifest) {
  const episode = read(`episode-${label}.json`);
  const recorded = episode.transcript.filter((r) => r.id);
  let cursor = 0;
  const replay = await runEpisode({
    index,
    strategy,
    reminders,
    tag,
    maxCalls: protocol.maxCalls,
    maxUsd: protocol.perEpisodeUsd,
    conversationCache: protocol.conversationCache ?? false,
    provider: {
      async call(request, options) {
        if (cursor === recorded.length && episode.reason === "budget-limit")
          throw Error("Study provider ceiling reached");
        const row = recorded[cursor++];
        assert.ok(row, "Replay asked for an unrecorded response");
        const stored = raw.get(row.id),
          receipt = receiptMap.get(row.id);
        assert.ok(!used.has(row.id));
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
  assert.deepEqual(replay.verdict, episode.verdict);
  assert.deepEqual(replay.transcript, episode.transcript);
  assert.deepEqual(replay.publicConversation, episode.publicConversation);
  assert.equal(replay.reason, episode.reason);
  assert.equal(replay.cost.providerUsd, episode.cost.providerUsd);
  assert.equal(replay.cost.toolCalls, episode.cost.toolCalls);
  // Post-collection diagnostic: outcome and paid overhead at the first handoff.
  // It never changes the frozen episode score or feeds candidate selection.
  let handoff = null;
  if (
    episode.transcript.some(
      (e) =>
        e.type === "tool" &&
        e.seat === "actor" &&
        e.name === "transfer_to_human_agents" &&
        !e.error,
    )
  ) {
    const bridge = createBridge();
    let callsThroughHandoff = 0,
      costThroughHandoff = 0;
    try {
      await bridge.request({ method: "reset", index });
      for (const row of episode.transcript) {
        if (row.id) {
          callsThroughHandoff++;
          costThroughHandoff += receiptMap.get(row.id).usd;
        }
        if (row.type !== "tool") continue;
        await bridge.request({
          method: "call",
          role: row.seat === "actor" ? "assistant" : "user",
          name: row.name,
          arguments: row.arguments,
        });
        if (row.seat === "actor" && row.name === "transfer_to_human_agents" && !row.error) {
          handoff = {
            verdict: await bridge.request({ method: "judge" }),
            callsThroughHandoff,
            costThroughHandoff,
            postHandoffCalls: recorded.length - callsThroughHandoff,
            postHandoffUsd: episode.cost.providerUsd - costThroughHandoff,
          };
          break;
        }
      }
    } finally {
      bridge.close();
    }
  }
  summaries.push({
    label,
    index,
    passed: episode.verdict.passed,
    reason: episode.reason,
    modelCalls: recorded.length,
    toolCalls: episode.cost.toolCalls,
    providerUsd: episode.cost.providerUsd,
    handoff,
  });
}
if (learning) {
  const proposal = read("proposal.json"),
    candidate = read("candidate.json"),
    response = raw.get(proposal.id);
  assert.equal(response.tag, "proposal");
  assert.equal(response.request.max_tokens, 2048);
  assert.deepEqual(
    JSON.parse(
      response.response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    ),
    proposal.edit,
  );
  if (protocol.editMode === "append") {
    assert.deepEqual(Object.keys(proposal.edit), ["append"]);
    assert.ok(proposal.edit.append.trim().length > 0 && proposal.edit.append.trim().length <= 600);
    assert.equal(candidate.actor, protocol.initialActor + "\n\n" + proposal.edit.append.trim());
    const feedbackRows = read("source-feedback.json");
    const { projectFeedback } = await import(
      pathToFileURL(path.join(replayRoot, "benchmarks/learning-strategy/telecom/feedback.mjs")).href
    );
    for (const { index, feedback } of feedbackRows) {
      const frozenResult = (run, file) =>
        JSON.parse(
          fs.readFileSync(
            path.join(replayRoot, "benchmarks/learning-strategy/results", run, file),
            "utf8",
          ),
        );
      assert.deepEqual(JSON.parse(feedback), {
        baseline: projectFeedback(frozenResult(protocol.pilotId, `episode-${index}.json`)),
        previousAttempt: {
          actor: frozenResult(protocol.previousCorrection, "candidate.json").actor,
          evidence: projectFeedback(
            frozenResult(protocol.previousCorrection, `episode-source-development-${index}.json`),
          ),
        },
      });
      assert.ok(response.request.messages[0].content.includes(feedback));
    }
    const sourceDb = new DatabaseSync(path.join(root, "source.sqlite"), { readOnly: true });
    try {
      const persisted = sourceDb
        .prepare(`SELECT t.feedback FROM strategy_trials t
        JOIN strategy_batches b ON b.id=t.batch WHERE b.strategy=? ORDER BY t.rowid`)
        .all(complete.priorResult.strategy)
        .map((row) => row.feedback);
      assert.deepEqual(
        persisted,
        feedbackRows.map((row) => row.feedback),
      );
    } finally {
      sourceDb.close();
    }
  } else assert.equal(candidate.actor, proposal.edit.actor);
  assert.equal(candidate.proposer, protocol.initialProposer);
  assert.ok(!used.has(proposal.id));
  used.add(proposal.id);
  assert.equal(proposal.cost, receiptMap.get(proposal.id).usd);
  assert.ok(protocol.recipientIndices.every((i) => !protocol.sourceIndices.includes(i)));
  assert.equal(
    complete.sourceGate,
    complete.qualified.successes === complete.qualified.total &&
      complete.qualified.successes > complete.priorResult.successes &&
      summaries
        .filter((e) => e.label.startsWith("source-"))
        .every((e) =>
          (protocol.adapterRevision ? ["user-ended", "human-transfer"] : ["user-ended"]).includes(
            e.reason,
          ),
        ),
  );
  assert.equal(manifest.length, complete.sourceGate ? 6 : 2);
  if (complete.sourceGate) {
    const envelope = read("transfer-envelope.json"),
      bytes = Buffer.from(envelope.skill_md, "base64");
    assert.equal(hash(bytes.toString("utf8")), envelope.content_hash);
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(envelope.author_pubkey, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    assert.ok(verify(null, bytes, key, Buffer.from(envelope.signature, "base64")));
    const packet = JSON.parse(
      Buffer.from(
        bytes.toString("utf8").match(/bitterbot-learning-strategy-v1:([A-Za-z0-9+/=]+)/)[1],
        "base64",
      ).toString("utf8"),
    );
    assert.equal(packet.strategies.length, 2);
    assert.ok(packet.strategies.every((s) => s.sharing === "shareable"));
    assert.ok(packet.strategies.some((s) => s.actor === candidate.actor));
  }
}
assert.equal(used.size, receipts.length);
const paid = receipts.reduce((s, r) => s + r.usd, 0);
const stores = learning
  ? ["source", ...(complete.sourceGate ? ["recipient-baseline", "recipient-transferred"] : [])]
  : conditional
    ? complete.evaluations.map((e) => e.store)
    : ["pilot"];
const runs = stores.flatMap((name) => {
  const db = new DatabaseSync(path.join(root, `${name}.sqlite`), { readOnly: true });
  const rows = db.prepare("SELECT status,cost,passed FROM learning_runs").all();
  if (conditional || name.startsWith("recipient-")) {
    const seals = db.prepare("SELECT candidates FROM strategy_seals").all();
    assert.equal(seals.length, 1);
    assert.equal(JSON.parse(seals[0].candidates).length, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM learning_runs WHERE partition!='held-out'").get().n,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM strategy_proposals").get().n, 0);
  }
  db.close();
  return rows;
});
assert.equal(
  runs.length,
  learning ? manifest.length + 3 : conditional ? manifest.length : protocol.indices.length,
);
assert.ok(runs.every((r) => r.status === "settled"));
const sqlCost = runs.reduce((s, r) => s + JSON.parse(r.cost).providerUsd, 0);
assert.ok(Math.abs(sqlCost - paid) < 1e-9);
assert.ok(Math.abs(paid - complete.provider.spent) < 1e-9);
if (conditional) {
  const expected = protocol.schedule.flatMap((block) =>
    block.indices.map((index) => ({
      label: `${block.arm}-${block.repetition}-${index}`,
      index,
      arm: block.arm,
      repetition: block.repetition,
      strategy: block.arm === "static" ? protocol.staticActor : protocol.initialActor,
      reminders: block.arm === "conditional" ? protocol.reminders : [],
    })),
  );
  assert.deepEqual(manifest, expected.slice(0, manifest.length));
  assert.ok(manifest.length <= expected.length);
  if (complete.collectionStatus === "complete") {
    assert.equal(manifest.length, expected.length);
    assert.ok(summaries.every((e) => ["user-ended", "human-transfer"].includes(e.reason)));
  }
  for (const group of complete.evaluations) {
    const subset = summaries.filter(
      (e) =>
        e.label.startsWith(`${group.arm}-${group.repetition}-`) && group.indices.includes(e.index),
    );
    assert.equal(
      subset.filter((e) => e.passed && ["user-ended", "human-transfer"].includes(e.reason)).length,
      group.result.successes,
    );
    assert.ok(
      Math.abs(subset.reduce((sum, e) => sum + e.providerUsd, 0) - group.result.cost.providerUsd) <
        1e-9,
    );
  }
} else if (!learning) {
  assert.ok(Math.abs(paid - complete.evaluation.cost.providerUsd) < 1e-9);
  assert.equal(summaries.filter((e) => e.passed).length, complete.evaluation.successes);
} else {
  for (const group of [
    { label: "source-development", result: complete.qualified },
    ...complete.recipients.map((r) => ({ label: `recipient-${r.arm}`, result: r.result })),
  ]) {
    const subset = summaries.filter((e) => e.label.startsWith(group.label));
    assert.equal(subset.filter((e) => e.passed).length, group.result.successes);
    assert.ok(
      Math.abs(subset.reduce((s, e) => s + e.providerUsd, 0) - group.result.cost.providerUsd) <
        1e-9,
    );
  }
}
const budget = read("project-budget.json");
const exposure = budget.priorExposure.reduce((s, r) => s + r.usd, 0);
assert.ok(exposure + paid <= budget.ceiling);
console.log(
  JSON.stringify(
    {
      status: "passed",
      sourceFiles: freeze.sources.length,
      workingTreeDifferences: currentDifferences,
      modelCalls: receipts.length,
      episodes: summaries,
      providerUsd: paid,
      priorExposureUsd: exposure,
      cumulativeExposureUsd: exposure + paid,
      headroomGate: complete.headroomGate,
      sourceGate: complete.sourceGate,
      note: "All episode responses replayed through native tools without new model calls; source, prompt, proposal (if any) and ledger checks passed.",
    },
    null,
    2,
  ),
);
