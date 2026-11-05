import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runEpisode } from "./episode-recovery.mjs";
import { checkFreeze, freezeSources } from "./procedure-protocol.mjs";
import { createProvider, hash, model, rates, priorExposure, usageCost } from "./provider.mjs";

const [mode, id] = process.argv.slice(2);
assert.ok(["prepare", "run", "audit"].includes(mode) && /^[\w-]+$/.test(id ?? ""));
const results = "benchmarks/learning-strategy/results";
const root = path.join(results, id);
const source = path.join(results, "telecom-prerequisite-source-v1");
const read = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const write = (n, v) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(v, null, 2) + "\n", { flag: "wx" });
const original = read(source, "episode-explicit-1-39.json");
const oldResponses = original.transcript
  .filter((r) => r.id)
  .map((r) => read(source, `responses/${r.id}.json`));
if (mode === "prepare") {
  const base = checkFreeze(source);
  const protocol = {
    kind: "bounded-publication-recovery-qualification",
    model,
    rates,
    repetitions: 8,
    historicalTrial: "explicit-1-39",
    source,
    correctionCallsPerTrial: 1,
    circuitBreakerUsd: 5,
    criterion:
      "All eight real customer continuations must publish valid current observations in one call. No additional native diagnostics or repair, no invalid observation delivery. Historical request prefix must match exactly; old outcome stays unchanged. This qualifies a correction interface on one recorded error, not task performance or error-rate generalization.",
  };
  fs.mkdirSync(root);
  write("protocol.json", protocol);
  freezeSources(root, protocol, [
    ...base.sources.map((s) => s.file),
    ...["episode-recovery.mjs", "publication-recovery.mjs", "recovery-qualify.mjs"].map(
      (n) => `benchmarks/learning-strategy/telecom/${n}`,
    ),
    path.join(source, "protocol.json"),
    path.join(source, "episode-explicit-1-39.json"),
    ...original.transcript
      .filter((r) => r.id)
      .map((r) => path.join(source, `responses/${r.id}.json`)),
  ]);
  console.log(JSON.stringify({ status: "prepared", repetitions: 8 }));
} else {
  checkFreeze(root);
  const protocol = read(root, "protocol.json");
  const lockPath = path.join(results, ".collector.lock");
  const lock = mode === "run" ? fs.openSync(lockPath, "wx") : null;
  if (lock !== null) fs.writeSync(lock, JSON.stringify({ id, pid: process.pid }));
  const provider = mode === "run" ? createProvider(root, protocol.circuitBreakerUsd) : null;
  const prior = priorExposure(results)
    .filter((r) => r.run !== id)
    .reduce((s, r) => s + r.usd, 0);
  const rows = [];
  try {
    for (let repetition = 0; repetition < protocol.repetitions; repetition++) {
      let cursor = 0,
        fresh = null,
        corrected = false;
      const result = await runEpisode({
        index: 39,
        strategy: read(source, "protocol.json").actors.explicit,
        tag: "explicit-1-39",
        maxCalls: 128,
        maxUsd: 3,
        conversationCache: true,
        provider: {
          call: async (request, options) => {
            if (cursor < oldResponses.length) {
              const r = oldResponses[cursor++];
              assert.deepEqual({ model, max_tokens: 1024, ...request }, r.request);
              assert.equal(options.tag, r.tag);
              return {
                id: `prefix-${cursor}`,
                content: r.response.content,
                usd: 0,
                stopReason: r.response.stop_reason,
              };
            }
            if (!corrected) {
              assert.equal(options.tag.split(":").at(-2), "user");
              corrected = true;
              const tag = `recovery-${repetition}`;
              if (mode === "run") fresh = await provider.call(request, { tag });
              else {
                const row = read(root, `trial-${repetition}.json`),
                  raw = read(root, `responses/${row.responseId}.json`);
                assert.deepEqual({ model, max_tokens: 1024, ...request }, raw.request);
                assert.equal(raw.tag, tag);
                fresh = {
                  id: row.responseId,
                  content: raw.response.content,
                  usd: usageCost(raw.response.usage),
                  stopReason: raw.response.stop_reason,
                };
              }
              return fresh;
            }
            assert.equal(
              options.tag.split(":").at(-2),
              "actor",
              "Correction tried additional private tool calls",
            );
            return {
              id: "qualification-stop",
              usd: 0,
              stopReason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "stop",
                  name: "transfer_to_human_agents",
                  input: { summary: "End interface qualification without further repairs." },
                },
              ],
            };
          },
        },
      });
      const calls = fresh?.content.filter((b) => b.type === "tool_use") ?? [];
      const passed =
        calls.length === 1 &&
        calls[0].name === "share_observations" &&
        result.publicationRecoveries === 1 &&
        result.reason === "human-transfer" &&
        result.transcript.filter((t) => t.type === "observation-failure").length === 1 &&
        result.publicConversation.length === original.publicConversation.length + 1 &&
        result.cost.toolCalls === original.cost.toolCalls + 1 &&
        result.verdict.passed === false;
      const row = {
        repetition,
        passed,
        responseId: fresh?.id,
        providerUsd: fresh?.usd,
        prefixCalls: cursor,
        reason: result.reason,
        publicationRecoveries: result.publicationRecoveries,
        originalOutcomeUnchanged: original.verdict.passed === false,
      };
      if (mode === "run") {
        write(`trial-${repetition}.json`, row);
        write(`episode-${repetition}.json`, result);
      } else {
        assert.deepEqual(row, read(root, `trial-${repetition}.json`));
        const saved = read(root, `episode-${repetition}.json`);
        for (const key of ["transcript", "publicConversation", "reason", "verdict"])
          assert.deepEqual(result[key], saved[key]);
      }
      rows.push(row);
      console.error(JSON.stringify({ repetition, passed }));
    }
    const output = {
      status: rows.every((r) => r.passed) ? "passed" : "failed",
      trials: rows.length,
      modelCalls: rows.length,
      providerUsd: rows.reduce((s, r) => s + r.providerUsd, 0),
      rows,
      qualificationOnly: true,
      repairsClaimed: 0,
      audit: mode === "audit",
    };
    output.cumulativeExposureUsd = prior + output.providerUsd;
    if (mode === "run") write("complete.json", { ...output, provider: provider.status() });
    else {
      const ledger = fs
        .readFileSync(path.join(root, "provider.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      const intents = ledger.filter((r) => r.type === "intent"),
        receipts = ledger.filter((r) => r.type === "receipt");
      assert.equal(intents.length, rows.length);
      assert.equal(receipts.length, rows.length);
      for (const row of rows) {
        const raw = read(root, `responses/${row.responseId}.json`),
          intent = intents.find((i) => i.id === row.responseId),
          receipt = receipts.find((r) => r.id === row.responseId);
        assert.equal(raw.status, 200);
        assert.equal(raw.response.model, model);
        assert.equal(hash(raw.request), intent.promptHash);
        assert.equal(row.providerUsd, receipt.usd);
        assert.deepEqual(raw.response.usage, receipt.usage);
        assert.ok(receipt.usd <= intent.quote);
      }
      write("audit.json", output);
    }
    console.log(JSON.stringify(output));
  } finally {
    if (lock !== null) {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }
}
