import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clusterInterval } from "./evidence-protocol.mjs";
import { procedureGate, checkFreeze } from "./procedure-protocol.mjs";

const root = path.resolve(process.argv[2] ?? "");
checkFreeze(root);
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const protocol = read("protocol.json"),
  audit = read("audit.json");
assert.equal(audit.status, "passed");
const ledger = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((r) => r.type === "receipt");
const episodes = audit.episodes.map((e) => {
  const raw = read(`episode-${e.label}.json`),
    calls = ledger.filter((r) => r.tag.startsWith(e.label + ":"));
  assert.equal(calls.length, e.modelCalls);
  const usage = calls.reduce(
    (s, { usage: u }) => ({
      input:
        s.input +
        u.input_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      output: s.output + u.output_tokens,
    }),
    { input: 0, output: 0 },
  );
  const tools = raw.transcript.filter((r) => r.type === "tool");
  return {
    ...e,
    interfaceFailures: raw.transcript.filter((r) =>
      ["observation-failure", "grounding"].includes(r.type),
    ).length,
    usage,
    uncachedEquivalentUsd:
      (usage.input * protocol.rates.input + usage.output * protocol.rates.output) / 1e6,
    toolCounts: Object.fromEntries(
      [...new Set(tools.map((r) => r.name))]
        .sort()
        .map((name) => [name, tools.filter((r) => r.name === name).length]),
    ),
  };
});
const metrics = ["modelCalls", "toolCalls", "providerUsd", "uncachedEquivalentUsd"];
const arms = protocol.arms.map((arm) => {
  const group = episodes.filter((r) => r.arm === arm);
  return {
    arm,
    total: group.length,
    successes: group.filter((r) => r.passed).length,
    interfaceFailures: group.reduce((s, r) => s + r.interfaceFailures, 0),
    naturalCompletions: group.filter((r) =>
      ["user-ended", "human-transfer"].includes(r.termination),
    ).length,
    ...Object.fromEntries(metrics.map((m) => [m, group.reduce((s, r) => s + r[m], 0)])),
  };
});
const cases = protocol.indices.map((index) => ({
  index,
  arms: protocol.arms.map((arm) => {
    const group = episodes.filter((r) => r.index === index && r.arm === arm);
    assert.equal(group.length, protocol.repetitions);
    return {
      arm,
      total: group.length,
      successes: group.filter((r) => r.passed).length,
      ...Object.fromEntries(
        metrics.map((m) => [m, group.reduce((s, r) => s + r[m], 0) / group.length]),
      ),
    };
  }),
}));
const comparisons = protocol.arms
  .filter((a) => a !== "learned")
  .map((control) => {
    const perCase = cases.map((c) => {
      const l = c.arms.find((a) => a.arm === "learned"),
        b = c.arms.find((a) => a.arm === control);
      return {
        index: c.index,
        success: (l.successes - b.successes) / protocol.repetitions,
        ...Object.fromEntries(metrics.map((m) => [m, l[m] - b[m]])),
      };
    });
    return {
      control,
      perCase,
      intervals: Object.fromEntries(
        ["success", ...metrics].map((m) => [m, clusterInterval(perCase.map((r) => r[m]))]),
      ),
    };
  });
const output = {
  status: "passed",
  stage: protocol.stage,
  candidateHash: protocol.candidateHash,
  arms,
  cases,
  episodes,
  comparisons,
  advancementGate: procedureGate(protocol.stage, episodes),
  newPaidUsd: audit.providerUsd,
  cumulativeExposureUsd: audit.cumulativeExposureUsd,
  discoveryAllocationUsd: protocol.discoveryAllocationUsd,
  productionActivation: false,
  note: "All assigned outcomes retained. Source cases are consumed development. Fresh/recipient panels are small convenience samples, repeated unseeded draws, and not independent user trials. Advancing a gate is exploratory. Mutation counts are descriptive and do not by themselves establish necessity or consent compliance.",
};
console.log(JSON.stringify(output, null, 2));
