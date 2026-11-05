import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFreeze, consumedCases } from "./procedure-protocol.mjs";
import { compilerFeedback } from "./rediscovery-compile-feedback.mjs";
import { CONFIRMATION } from "./rediscovery-protocol.mjs";

// Post-collection diagnostics only: no provider, simulator mutations, or feedback writes.
const root = path.resolve(process.argv[2] ?? "");
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
checkFreeze(root);
const p = read("protocol.json"),
  audit = read("audit.json"),
  analysis = read("analysis.json");
assert.equal(p.stage, "discovery");
assert.equal(audit.status, "passed");
assert.equal(analysis.status, "passed");
const complete = read("complete.json");
const proposals = complete.proposalLabels.map((label) => {
  const proposal = read(`proposal-${label}.json`),
    round = read(`round-${label}.json`);
  const raw = read(`responses/${proposal.programId}.json`).response;
  const diagnostic = compilerFeedback(raw);
  assert.equal(diagnostic.valid, proposal.generated.valid);
  const rows = analysis.rows.filter((r) => r.label.startsWith(`${label}-case-`));
  assert.equal(rows.length, 6);
  return {
    label,
    branch: proposal.branch,
    round: proposal.round,
    valid: diagnostic.valid,
    errors: diagnostic.errors,
    delivery: proposal.generated.program?.delivery ?? null,
    submittedCharacters: diagnostic.previousSubmission.length,
    evaluatedBehavior: diagnostic.valid ? "generated-program" : "baseline-fallback",
    repairs: round.successes,
    episodes: rows.length,
    evaluationUsd: rows.reduce((s, r) => s + r.providerUsd, 0),
    engineerUsd: proposal.providerUsd,
    compilerFeedbackWasProvidedToEngineer: false,
  };
});
const probes = complete.proposalLabels.flatMap((label) =>
  read(`proposal-${label}.json`)
    .probeResults.filter((r) => r.case)
    .map((r) => ({ proposal: label, ...r })),
);
const feedbackTraces = complete.proposalLabels.flatMap((label) => {
  const proposal = read(`proposal-${label}.json`);
  return typeof proposal.packet.evidence === "object"
    ? proposal.packet.evidence.traces.map((trace) => ({ proposal: label, ...trace }))
    : [];
});
const used = new Set(consumedCases(path.dirname(root)));
const reviewedIndices = [...new Set([...p.indices, ...CONFIRMATION])];
assert.ok(
  reviewedIndices.every((i) => used.has(i)),
  "Do not inspect reserved scenarios",
);
const dataset =
  "benchmarks/learning-strategy/datasets/tau-bench-v2-en/upstream/data/tau2/multilingual/en/telecom_tasks_en.json";
const datasetBytes = fs.readFileSync(dataset),
  tasks = JSON.parse(datasetBytes);
const contracts = reviewedIndices.map((index) => {
  const task = tasks[index],
    assertion = task.evaluation_criteria.env_assertions.find(
      (a) => a.func_name === "assert_data_refueling_amount",
    );
  const instructions = task.user_scenario.instructions.task_instructions;
  return {
    index,
    panel: p.indices.includes(index) ? "discovery" : "planned-confirmation",
    exactRefuelAmount: assertion?.arguments.expected_amount ?? null,
    willingnessSentence:
      instructions.match(/[^.]*willing to refuel.*?GB[^.]*\./i)?.[0]?.trim() ?? null,
    ambiguityFlag: Boolean(assertion && /willing to refuel/i.test(instructions)),
  };
});
const quantityOnlyFailures = [];
for (const row of analysis.rows) {
  const e = read(`episode-${row.label}.json`),
    criteria = tasks[row.index].evaluation_criteria.env_assertions;
  assert.equal(e.verdict.checks.length, criteria.length);
  const quantity = criteria.findIndex((a) => a.func_name === "assert_data_refueling_amount");
  if (
    quantity < 0 ||
    e.verdict.checks[quantity] !== false ||
    e.verdict.checks.some((v, i) => i !== quantity && !v)
  )
    continue;
  quantityOnlyFailures.push({
    label: row.label,
    index: row.index,
    nativePassed: e.verdict.passed,
    nativeChecks: e.verdict.checks,
    expectedAmount: criteria[quantity].arguments.expected_amount,
    refuelActions: e.transcript
      .filter((t) => t.type === "tool" && t.name === "refuel_data")
      .map((t) => ({ arguments: t.arguments, result: t.content, error: t.error })),
    publicQuantityDialogue: e.publicConversation
      .filter((r) => /\bGB\b|gigabyte|refuel|top.?up/i.test(r.text))
      .map(({ seat, text }) => ({ seat, text })),
    interpretation:
      "Quantity-only failure flagged for review. This is not automatic rescoring or proof of a consent conflict in every flagged trial.",
  });
}
const groups = [true, false].map((valid) => {
  const rows = proposals.filter((r) => r.valid === valid);
  return {
    behavior: valid ? "generated-program" : "baseline-fallback-after-invalid-submission",
    proposals: rows.length,
    episodes: rows.reduce((s, r) => s + r.episodes, 0),
    repairs: rows.reduce((s, r) => s + r.repairs, 0),
    evaluationUsd: rows.reduce((s, r) => s + r.evaluationUsd, 0),
    engineerUsd: rows.reduce((s, r) => s + r.engineerUsd, 0),
  };
});
assert.equal(
  groups.reduce((s, r) => s + r.episodes, 0),
  72,
);
const sources = [
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./rediscovery-compile-feedback.mjs", import.meta.url)),
];
const sourceSnapshots = sources.map((source) => {
  const bytes = fs.readFileSync(source),
    name = "review-source-" + path.basename(source);
  fs.writeFileSync(path.join(root, name), bytes, { flag: "wx" });
  return { source, snapshot: name, sha256: sha(bytes) };
});
const output = {
  status: "completed-postcollection-review",
  run: path.basename(root),
  episodesInspected: analysis.rows.length,
  originalOutcomesUnchanged: true,
  newProviderCalls: 0,
  datasetSha256: sha(datasetBytes),
  sourceSnapshots,
  proposalDiagnostics: proposals,
  behaviorGroups: groups,
  diagnosticProbes: {
    attempted: probes.length,
    errors: probes.filter((r) => r.error).length,
    completed: probes.filter((r) => !r.error).length,
    failedStateProbes: probes.filter((r) => r.beforePassed === false).length,
    failedStatesRepaired: probes.filter((r) => r.beforePassed === false && r.afterPassed === true)
      .length,
    passingStatesBroken: probes.filter((r) => r.beforePassed === true && r.afterPassed === false)
      .length,
  },
  feedbackCoverage: {
    tracesSupplied: feedbackTraces.length,
    explicitlyTruncated: feedbackTraces.filter((r) => r.traceTruncated).length,
    failedTracesSupplied: feedbackTraces.filter((r) => !r.passed).length,
    failedTracesTruncated: feedbackTraces.filter((r) => !r.passed && r.traceTruncated).length,
    limitation:
      "The existing feedback projector collapses synthetic identifiers and omits tool arguments and nested results. Separate observed bindings do not restore their association with actions. Truncation is marked, but diagnoses may lack decisive intermediate evidence.",
  },
  contracts,
  quantityOnlyFailures,
  compilerFeedbackCandidate: {
    status: "offline-qualified-only",
    agreesWithFrozenCompiler: `${proposals.length}/${proposals.length}`,
    repairsAutomatically: false,
    suppliedDuringThisExperiment: false,
    demonstratedModelBenefit: false,
  },
  nextStageDecision: {
    decision: "defer-confirmation-and-preserve-fresh-cases",
    basis:
      "Observed conflict between customer-approved 1GB purchase and exact-2GB native grade, plus willingness/exact-amount ambiguity in planned confirmation cases. Qualify the task/customer/evaluator contract under a separately frozen protocol before efficacy comparison.",
    preregisteredConfirmationGateEvaluated: false,
    interpretation:
      "This is a post-discovery measurement-quality decision, not a failed confirmation result, changed native score, or amended efficacy gate.",
  },
};
checkFreeze(root);
fs.writeFileSync(
  path.join(root, "postcollection-review.json"),
  JSON.stringify(output, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      status: output.status,
      groups,
      diagnosticProbes: output.diagnosticProbes,
      flagged: quantityOnlyFailures.map((r) => r.label),
      confirmationAmbiguities: contracts
        .filter((r) => r.panel === "planned-confirmation" && r.ambiguityFlag)
        .map((r) => r.index),
    },
    null,
    2,
  ),
);
