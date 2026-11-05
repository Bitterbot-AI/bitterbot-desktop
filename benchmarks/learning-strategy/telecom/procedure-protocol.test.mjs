import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { learningHash } from "../../../src/memory/procedural-learning-contract.ts";
import { ProceduralLearningStore } from "../../../src/memory/procedural-learning-store.ts";
import { ProceduralLearning } from "../../../src/memory/procedural-learning.ts";
import { ACTOR, PROPOSER } from "./episode.mjs";
import { projectFeedback } from "./feedback.mjs";
import {
  STAGES,
  CHECKLIST,
  SOURCE_RUN,
  sourceFeedback,
  proposalRequest,
  procedureGate,
  consumedCases,
} from "./procedure-protocol.mjs";
const rowsFor = (stage) =>
  STAGES[stage].arms.flatMap((arm) =>
    STAGES[stage].indices.flatMap((index) =>
      Array.from({ length: STAGES[stage].repetitions }, (_, repetition) => ({
        arm,
        index,
        repetition,
        termination: "user-ended",
        passed: true,
      })),
    ),
  );
test("the fixed panels are disjoint, balanced and reserve four untouched recipient combinations", () => {
  const sets = Object.values(STAGES).map((s) => s.indices);
  assert.equal(new Set(sets.flat()).size, sets.flat().length);
  assert.deepEqual(
    Object.keys(STAGES).map((s) => rowsFor(s).length),
    [24, 54, 24],
  );
  assert.ok(CHECKLIST.length <= 600);
  const consumed = consumedCases("benchmarks/learning-strategy/results");
  // Original development is deliberately consumed; fresh reservation is checked at preparation.
  assert.ok(STAGES.source.indices.every((i) => consumed.includes(i)));
});
test("source gate requires all learned repairs, strict baseline improvement and exact assigned membership", () => {
  const rows = rowsFor("source");
  assert.equal(procedureGate("source", rows).passed, false);
  rows.find((r) => r.arm === "baseline").passed = false;
  assert.equal(procedureGate("source", rows).passed, true);
  rows.find((r) => r.arm === "learned").passed = false;
  assert.equal(procedureGate("source", rows).passed, false);
  rows.find((r) => r.arm === "learned").passed = true;
  assert.equal(procedureGate("source", rows.slice(1)).passed, false);
  assert.equal(
    procedureGate("source", [...rows.slice(1), { ...rows[0], index: 999 }]).complete,
    false,
  );
  rows[0].termination = "budget-limit";
  assert.equal(procedureGate("source", rows).passed, false);
});
test("fresh advancement rejects a hidden case regression and a cheaper but less successful candidate", () => {
  const rows = rowsFor("fresh");
  rows.filter((r) => r.arm === "baseline" && r.index === 5).forEach((r) => (r.passed = false));
  assert.equal(procedureGate("fresh", rows).passed, true);
  rows.find((r) => r.arm === "learned" && r.index === 6).passed = false;
  assert.equal(procedureGate("fresh", rows).passed, false);
  assert.deepEqual(procedureGate("fresh", rows).regressions, [6]);
});
test("proposal input reconstructs twelve baseline histories without host diagnoses or manual advice", () => {
  const feedback = sourceFeedback(path.join("benchmarks/learning-strategy/results", SOURCE_RUN));
  assert.equal(feedback.length, 12);
  assert.equal(feedback.filter((r) => r.passed).length, 9);
  assert.ok(feedback.every((r) => r.label.startsWith("baseline-")));
  const request = proposalRequest(feedback.map((r) => r.feedback));
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2048, ...request }),
    ) <= 140000,
  );
  for (const row of feedback) {
    const episode = JSON.parse(
      fs.readFileSync(
        path.join("benchmarks/learning-strategy/results", SOURCE_RUN, `episode-${row.label}.json`),
        "utf8",
      ),
    );
    const original = projectFeedback(episode),
      compact = JSON.parse(row.feedback);
    assert.equal(original.timeline.length, compact.timeline.length);
    original.timeline.forEach((turn, i) => {
      if (!turn.observations) assert.deepEqual(compact.timeline[i], turn);
      else {
        const { observations, ...rest } = turn;
        assert.deepEqual(compact.timeline[i], {
          ...rest,
          publicSnapshot: Object.fromEntries(observations.records.map((r) => [r.fact, r.value])),
        });
      }
    });
  }
  const text = JSON.stringify(request);
  assert.ok(!text.includes(CHECKLIST));
  for (const marker of [
    "failureState",
    "assert_can_send_mms",
    "initialization_actions",
    "[PERSONA:",
    "originalOutcomeUnchanged",
  ])
    assert.ok(!text.includes(marker));
});
test("private customer tool and accompanying-text canaries never reach learned feedback", () => {
  const root = path.join("benchmarks/learning-strategy/results", SOURCE_RUN);
  const episode = JSON.parse(
    fs.readFileSync(path.join(root, "episode-baseline-0-36.json"), "utf8"),
  );
  episode.transcript.unshift(
    {
      seat: "user",
      id: "private-canary",
      content: [
        { type: "text", text: "PRIVATE_PREAMBLE_CANARY" },
        { type: "tool_use", name: "check_network_status", id: "canary", input: {} },
      ],
    },
    {
      type: "tool",
      seat: "user",
      name: "check_network_status",
      content: "PRIVATE_DIAGNOSTIC_CANARY",
      error: false,
    },
  );
  episode.privateFinalState = "PRIVATE_ORACLE_CANARY";
  const feedback = JSON.stringify(projectFeedback(episode));
  assert.ok(!feedback.includes("CANARY"));
  assert.ok(feedback.includes("timeline"));
});
test("existing proposal/archive API preserves baseline and canonical lineage under the bounded append", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "procedure-lab-test-")),
    budget = { providerUsd: 1, toolCalls: 0, wallMs: 10000 };
  const service = new ProceduralLearning(
    new ProceduralLearningStore(new DatabaseSync(path.join(temp, "test.sqlite")), {
      mode: "shadow",
      executionBudget: budget,
    }),
  );
  try {
    const lab = service.strategies,
      scope = { tool: "offline", version: "1", operation: "test", contractHash: "0".repeat(64) };
    const parent = lab.archive.add({
      schemaVersion: 1,
      scope,
      actor: ACTOR,
      proposer: PROPOSER,
      parents: [],
      sharing: "shareable",
      expiresAt: Date.now() + 86400000,
    });
    lab.registerPanel({
      id: "source",
      scope,
      partition: "development",
      sharing: "shareable",
      model: "offline",
      verifierHash: "1".repeat(64),
      isolation: "sandbox",
      cases: [
        { id: "a", input: 1 },
        { id: "b", input: 2 },
      ],
      quote: () => ({ providerUsd: 0, toolCalls: 0, wallMs: 1000 }),
      execute: async (_s, i) => ({ output: i, cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 } }),
      verify: async (_i, o) => ({
        passed: o === 2,
        feedback: `observed-${o}`,
        cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
      }),
    });
    await lab.evaluate(parent, "source", budget);
    const child = await lab.propose({
      parent,
      panel: "source",
      editMode: "append",
      evolveProposer: false,
      fixedProposer: PROPOSER,
      quote: { providerUsd: 1, toolCalls: 0, wallMs: 1000 },
      budget,
      generate: async (ctx) => {
        assert.deepEqual(ctx.feedback, ["observed-1", "observed-2"]);
        return {
          edit: { append: "Verify unresolved prerequisites." },
          cost: { providerUsd: 0, toolCalls: 0, wallMs: 0 },
        };
      },
    });
    const candidate = lab.archive.get(child);
    assert.equal(candidate.actor, ACTOR + "\n\nVerify unresolved prerequisites.");
    assert.deepEqual(candidate.parents, [parent]);
    assert.equal(learningHash(candidate), child);
    assert.equal(lab.archive.get(parent).actor, ACTOR);
  } finally {
    await service.close();
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
