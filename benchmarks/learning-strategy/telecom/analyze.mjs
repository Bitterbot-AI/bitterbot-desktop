import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Descriptive analysis only: no candidate selection, provider calls or retries.
const root = path.resolve(process.argv[2] ?? "");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const protocol = read("protocol.json"),
  complete = read("complete.json"),
  audit = read("audit.json");
assert.equal(audit.status, "passed");
const conditional = protocol.kind === "telecom-conditional-reminder-comparison";
assert.ok(conditional || protocol.kind === "telecom-single-correction-transfer");
assert.ok(Math.abs(audit.providerUsd - complete.provider.spent) < 1e-9);
const receipts = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((row) => row.type === "receipt");
const episodes = complete.executionManifest.map(({ label, index, arm, repetition }) => {
  const episode = read(`episode-${label}.json`);
  const calls = receipts.filter((row) => row.tag.startsWith(label + ":"));
  assert.equal(calls.length, episode.transcript.filter((row) => row.id).length);
  const tokens = calls.reduce(
    (sum, { usage: u }) => ({
      input:
        sum.input +
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      output: sum.output + u.output_tokens,
      cacheRead: sum.cacheRead + (u.cache_read_input_tokens ?? 0),
      cacheWrite: sum.cacheWrite + (u.cache_creation_input_tokens ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const paid = calls.reduce((sum, row) => sum + row.usd, 0);
  assert.ok(Math.abs(paid - episode.cost.providerUsd) < 1e-9);
  return {
    label,
    index,
    ...(conditional ? { arm, repetition } : {}),
    passed: episode.verdict.passed,
    termination: episode.reason,
    modelCalls: calls.length,
    toolCalls: episode.cost.toolCalls,
    reminders: episode.transcript
      .filter((r) => r.type === "reminder")
      .flatMap((r) => r.matches.map((m) => m.id)),
    paidUsd: paid,
    tokens,
    uncachedPriceEquivalentUsd:
      (tokens.input * protocol.rates.input + tokens.output * protocol.rates.output) / 1e6,
  };
});
const arms = (conditional ? protocol.arms : ["baseline", "transferred"]).map((arm) => {
  const group = episodes.filter((e) =>
    conditional ? e.arm === arm : e.label.startsWith(`recipient-${arm}-`),
  );
  return {
    arm,
    successes: group.filter((e) => e.passed).length,
    total: group.length,
    paidUsd: group.reduce((sum, e) => sum + e.paidUsd, 0),
    uncachedPriceEquivalentUsd: group.reduce((sum, e) => sum + e.uncachedPriceEquivalentUsd, 0),
    modelCalls: group.reduce((sum, e) => sum + e.modelCalls, 0),
    toolCalls: group.reduce((sum, e) => sum + e.toolCalls, 0),
  };
});
const [baseline, transferred] = arms;
const comparable =
  !conditional &&
  baseline.total === protocol.recipientIndices.length &&
  transferred.total === baseline.total &&
  episodes.every((e) => ["user-ended", "human-transfer"].includes(e.termination));
const comparison = comparable
  ? {
      successDelta: transferred.successes - baseline.successes,
      paidUsdDelta: transferred.paidUsd - baseline.paidUsd,
      uncachedPriceEquivalentUsdDelta:
        transferred.uncachedPriceEquivalentUsd - baseline.uncachedPriceEquivalentUsd,
      modelCallsDelta: transferred.modelCalls - baseline.modelCalls,
      toolCallsDelta: transferred.toolCalls - baseline.toolCalls,
      observedParetoImprovement:
        transferred.successes >= baseline.successes &&
        transferred.paidUsd <= baseline.paidUsd &&
        transferred.toolCalls <= baseline.toolCalls &&
        transferred.modelCalls <= baseline.modelCalls &&
        (transferred.successes > baseline.successes ||
          transferred.paidUsd < baseline.paidUsd ||
          transferred.toolCalls < baseline.toolCalls ||
          transferred.modelCalls < baseline.modelCalls),
    }
  : null;
const conditionalComparable =
  conditional &&
  complete.collectionStatus === "complete" &&
  arms.every((arm) => arm.total === protocol.indices.length * protocol.repetitions) &&
  episodes.every((e) => ["user-ended", "human-transfer"].includes(e.termination));
const conditionalComparisons = conditionalComparable
  ? ["baseline", "static"].map((control) => {
      const reference = arms.find((a) => a.arm === control),
        candidate = arms.find((a) => a.arm === "conditional");
      const pairs = episodes
        .filter((e) => e.arm === "conditional")
        .map((candidateEpisode) => {
          const other = episodes.find(
            (e) =>
              e.arm === control &&
              e.index === candidateEpisode.index &&
              e.repetition === candidateEpisode.repetition,
          );
          assert.ok(other);
          return {
            index: other.index,
            repetition: other.repetition,
            successDelta: Number(candidateEpisode.passed) - Number(other.passed),
            toolCallsDelta: candidateEpisode.toolCalls - other.toolCalls,
            modelCallsDelta: candidateEpisode.modelCalls - other.modelCalls,
          };
        });
      const noRegression = pairs.every((p) => p.successDelta >= 0);
      const cheaper =
        candidate.toolCalls <= reference.toolCalls &&
        candidate.modelCalls <= reference.modelCalls &&
        candidate.uncachedPriceEquivalentUsd <= reference.uncachedPriceEquivalentUsd;
      const improved =
        candidate.toolCalls < reference.toolCalls ||
        candidate.modelCalls < reference.modelCalls ||
        candidate.uncachedPriceEquivalentUsd < reference.uncachedPriceEquivalentUsd;
      return {
        control,
        pairs,
        observedGate: noRegression && cheaper && improved,
        paidUsdDelta: candidate.paidUsd - reference.paidUsd,
        uncachedPriceEquivalentUsdDelta:
          candidate.uncachedPriceEquivalentUsd - reference.uncachedPriceEquivalentUsd,
      };
    })
  : null;
const delivered = episodes
  .filter((e) => e.arm === "conditional")
  .reduce((sum, e) => sum + e.reminders.length, 0);
console.log(
  JSON.stringify(
    {
      sourceGate: complete.sourceGate,
      episodes,
      arms,
      comparison,
      ...(conditional
        ? {
            purpose: protocol.purpose,
            mechanism: { deliveries: delivered, status: delivered ? "exercised" : "unexercised" },
            conditionalComparisons,
            observedMechanismGate:
              conditionalComparisons === null
                ? null
                : conditionalComparisons.every((c) => c.observedGate) &&
                  (!protocol.purpose || delivered > 0),
          }
        : {}),
      newPaidUsd: complete.provider.spent,
      developmentAllocationUsd:
        complete.cumulativeDevelopmentAllocationUsd ?? complete.transferredDiscoveryAllocationUsd,
      cumulativeExposureUsd: complete.cumulativeExposureUsd,
      remainingExposureUsd: read("project-budget.json").ceiling - complete.cumulativeExposureUsd,
      note: "Uncached price equivalents price every observed input token at the same base rate; they are counterfactuals, not billed costs or evidence of latency. Small unseeded samples cannot establish a stable accuracy or efficiency gain. No statistical significance, break-even or live promotion claim.",
    },
    null,
    2,
  ),
);
