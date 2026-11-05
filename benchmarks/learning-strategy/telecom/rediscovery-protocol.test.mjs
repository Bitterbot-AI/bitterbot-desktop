import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { engineerPacket, feedbackRow, diagnosticProbes } from "./rediscovery-engineer.mjs";
import {
  ACTOR,
  TRAINING,
  CONFIRMATION,
  FRESH,
  RECIPIENT,
  checkPartitions,
  selectCandidate,
  comparisonSchedule,
  advancementGate,
} from "./rediscovery-protocol.mjs";
test("blind engineer gets no execution history, outcomes, diagnostic bindings or selected parent", () => {
  const packet = engineerPacket({
    branch: "blind",
    round: 2,
    actor: "its-own-prior-program",
    context: { policy: "public policy", agentTools: [], userTools: [] },
    feedback: ['{"secret":"unavailable-private-marker"}'],
  });
  assert.ok(!JSON.stringify(packet).includes("unavailable-private-marker"));
  assert.equal(packet.parentProgram, "its-own-prior-program");
});
test("partitions are disjoint and host selection excludes malformed submissions", () => {
  checkPartitions();
  assert.equal(TRAINING.length, 6);
  assert.equal(CONFIRMATION.length, 6);
  assert.equal(FRESH.length + RECIPIENT.length, 10);
  const rows = [
    { valid: false, successes: 6, modelCalls: 1, round: 0 },
    { valid: true, successes: 5, modelCalls: 20, round: 1 },
    { valid: true, successes: 5, modelCalls: 10, round: 2 },
  ];
  assert.equal(selectCandidate(rows).round, 2);
});
test("confirmation gate requires natural completion, held nominee, improvement and feedback advantage", () => {
  const p = {
    stage: "confirmation",
    arms: ["baseline", "experience-0", "blind-0", "experience-1", "blind-1"],
    indices: CONFIRMATION,
    repetitions: 2,
    nominated: "experience-0",
  };
  p.schedule = comparisonSchedule(p.arms, p.indices, p.repetitions);
  const rows = p.schedule.flatMap((b) =>
    b.indices.map((index) => ({
      arm: b.arm,
      repetition: b.repetition,
      index,
      passed: b.arm.startsWith("experience") || index !== CONFIRMATION[0],
      termination: "user-ended",
    })),
  );
  assert.equal(advancementGate(p, rows).passed, true);
  assert.equal(advancementGate(p, rows.slice(1)).passed, false);
  assert.equal(
    advancementGate(
      p,
      rows.map((r, i) => (i === 0 ? { ...r, termination: "simulator-observation-failure" } : r)),
    ).passed,
    false,
  );
  assert.equal(
    advancementGate(
      p,
      rows.map((r) => ({ ...r, passed: true })),
    ).passed,
    false,
  );
});
test("development probes restore a copy and reveal no hidden task specification", async () => {
  const e = JSON.parse(
    fs.readFileSync(
      "benchmarks/learning-strategy/results/telecom-prerequisite-source-v1/episode-baseline-0-36.json",
      "utf8",
    ),
  );
  const bank = new Map([["case-0", { index: 36, episode: e }]]);
  const plan = {
    hypotheses: "Inspect the unresolved service",
    probes: [
      { case: "case-0", actions: [{ role: "user", name: "can_send_mms", argumentsJson: "{}" }] },
    ],
  };
  const result = await diagnosticProbes(plan, "experience", bank);
  assert.equal(result[0].beforePassed, false);
  assert.equal(result[0].afterPassed, false);
  assert.equal(result[0].actions.length, 1);
  assert.ok(!JSON.stringify(result).includes("assert_can_send_mms"));
  assert.deepEqual(await diagnosticProbes(plan, "blind", bank), [{ status: "withheld-control" }]);
  const row = feedbackRow(e, "case-0");
  assert.equal(row.passed, false);
  assert.ok(!row.publicTrace.includes("[PERSONA:"));
  assert.notEqual(ACTOR, "");
});
