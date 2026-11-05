import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clusterInterval } from "./evidence-protocol.mjs";
import { checkFreeze } from "./procedure-protocol.mjs";
import { advancementGate } from "./rediscovery-protocol.mjs";
const root = path.resolve(process.argv[2] ?? "");
checkFreeze(root);
const read = (n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const p = read("protocol.json"),
  audit = read("audit.json"),
  complete = read("complete.json");
assert.equal(audit.status, "passed");
const receipts = fs
  .readFileSync(path.join(root, "provider.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((r) => r.type === "receipt");
const rows = audit.episodes.map((entry) => {
  const e = read(`episode-${entry.label}.json`),
    rs = receipts.filter((r) => r.tag.startsWith(entry.label + ":"));
  assert.equal(rs.length, entry.modelCalls);
  const input = rs.reduce(
    (s, r) =>
      s +
      r.usage.input_tokens +
      (r.usage.cache_read_input_tokens ?? 0) +
      (r.usage.cache_creation_input_tokens ?? 0),
    0,
  );
  const output = rs.reduce((s, r) => s + r.usage.output_tokens, 0);
  return {
    ...entry,
    toolCalls: e.cost.toolCalls,
    recoveredPublications: e.publicationRecoveries,
    interfaceRejections: e.transcript.filter((t) =>
      ["observation-failure", "grounding"].includes(t.type),
    ).length,
    uncachedEquivalentUsd: (input * p.rates.input + output * p.rates.output) / 1e6,
  };
});
const keys = p.stage === "discovery" ? p.branches : p.arms;
const arms = keys.map((arm) => {
  const g = rows.filter((r) => (r.arm ?? r.branch) === arm);
  return {
    arm,
    episodes: g.length,
    repairs: g.filter((r) => r.passed).length,
    natural: g.filter((r) => ["human-transfer", "user-ended"].includes(r.termination)).length,
    ...Object.fromEntries(
      [
        "modelCalls",
        "toolCalls",
        "providerUsd",
        "uncachedEquivalentUsd",
        "recoveredPublications",
        "interfaceRejections",
      ].map((key) => [key, g.reduce((s, r) => s + r[key], 0)]),
    ),
  };
});
let detail;
if (p.stage === "discovery") {
  const learningCurves = complete.selections.map((s) => ({
    branch: s.branch,
    selectedRound: s.round,
    rounds: s.candidates.map((c) => ({
      round: c.round,
      valid: c.valid,
      repairs: c.successes,
      total: c.total,
      modelCalls: c.modelCalls,
    })),
  }));
  const proposals = complete.proposalLabels.map((l) => read(`proposal-${l}.json`));
  detail = {
    learningCurves,
    nominated: complete.nominated,
    selections: complete.selections.map(({ candidates: _candidates, result: _result, ...s }) => s),
    diagnosticExperiments: proposals.flatMap((r) =>
      r.probeResults.filter((q) => q.case).map((q) => ({ proposal: r.label, ...q })),
    ),
    engineerProviderUsd: proposals.reduce((s, r) => s + r.providerUsd, 0),
    advancementGate: null,
    interpretation:
      "Adaptive acquisition results select candidates; they are not independent evidence of learning or generalization. The blind engineer receives no history or evaluation outcomes, but the host selects its best candidate with the same rule. This ablates feedback, not prior model knowledge or maximum resource opportunity.",
  };
} else {
  const cases = p.indices.map((index) => ({
    index,
    arms: p.arms.map((arm) => {
      const g = rows.filter((r) => r.index === index && r.arm === arm);
      assert.equal(g.length, p.repetitions);
      return { arm, repairs: g.filter((r) => r.passed).length, total: g.length };
    }),
  }));
  const pairs = [
    ...p.arms.filter((a) => a !== "baseline").map((a) => [a, "baseline"]),
    ...p.arms
      .filter((a) => a.startsWith("experience"))
      .map((a) => [a, a.replace("experience", "blind")]),
  ];
  const comparisons = pairs.map(([intervention, control]) => ({
    intervention,
    control,
    successDifference: clusterInterval(
      cases.map(
        (c) =>
          (c.arms.find((r) => r.arm === intervention).repairs -
            c.arms.find((r) => r.arm === control).repairs) /
          p.repetitions,
      ),
    ),
  }));
  detail = {
    cases,
    comparisons,
    advancementGate: advancementGate(p, rows),
    interpretation:
      p.stage === "confirmation"
        ? "Engineer-unseen cases were consumed by earlier host research. This is confirmation outside the acquisition cases, not globally fresh evaluation. Two discovery pairs and six case clusters are exploratory. No production or distributed-transfer claim."
        : "Globally reserved cases, no feedback/reselection. Small synthetic panel, not a population estimate or real-user result. No distributed transfer performed.",
  };
}
const output = {
  status: "passed",
  stage: p.stage,
  arms,
  ...detail,
  providerUsd: audit.providerUsd,
  cumulativeExposureUsd: audit.cumulativeExposureUsd,
  modelCalls: audit.modelCalls,
  programProjectionsReplayed: audit.programProjectionsReplayed,
  rows,
  productionActivation: false,
};
fs.writeFileSync(
  path.join(root, "trial-data.jsonl"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  { flag: "wx" },
);
console.log(JSON.stringify(output, null, 2));
