import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCompliance } from "./compliance-report.mjs";

function fixture(index, reason = "user-ended") {
  return {
    label: `conditional-0-${index}`,
    index,
    episode: {
      reason,
      verdict: { passed: true },
      cost: { providerUsd: 0.1, toolCalls: 2 },
      transcript: [
        {
          type: "public-observations",
          snapshot: {
            scope: 1,
            records: [{ fact: "service.mmsBlocked", value: true, revision: 1 }],
          },
        },
        {
          type: "public-observations",
          snapshot: {
            scope: 1,
            records: [{ fact: "service.mmsBlocked", value: false, revision: 2 }],
          },
        },
        { type: "reminder", matches: [{ id: "missing-allowance-check" }] },
      ],
    },
  };
}
test("compliance requires two natural completions and explicit nonempty reporting", () => {
  assert.equal(summarizeCompliance([fixture(29)]).interfaceGate, "failed-or-incomplete");
  for (const reason of [
    "budget-limit",
    "simulator-observation-failure",
    "simulator-grounding-failure",
    "call-limit",
  ]) {
    assert.equal(
      summarizeCompliance([fixture(29), fixture(33, reason)]).interfaceGate,
      "failed-or-incomplete",
    );
  }
  const empty = fixture(33);
  empty.episode.transcript = [];
  assert.equal(summarizeCompliance([fixture(29), empty]).interfaceGate, "failed-or-incomplete");
});
test("refresh and reminder coverage are separate from valid reporting and task success", () => {
  const episodes = [fixture(29), fixture(33)];
  const report = summarizeCompliance(episodes);
  assert.equal(report.interfaceGate, "passed");
  assert.equal(report.refreshCoverage, "exercised");
  assert.equal(report.reminderCoverage, "exercised");
  assert.equal(report.rows[0].changedValues, 1);
  assert.equal(report.learningBenefitEstablished, false);
  for (const row of episodes) {
    row.episode.transcript = row.episode.transcript.slice(0, 1);
    row.episode.verdict.passed = false;
  }
  const partial = summarizeCompliance(episodes);
  assert.equal(partial.interfaceGate, "passed");
  assert.equal(partial.nextStep, "coverage-incomplete");
});
