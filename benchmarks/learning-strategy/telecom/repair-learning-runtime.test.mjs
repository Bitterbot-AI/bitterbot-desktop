import assert from "node:assert/strict";
import test from "node:test";
import {
  learningEvidence,
  controllerPacket,
  generateController,
  runControllerAttempt,
  summarizeLearning,
} from "./repair-learning-runtime.mjs";

const def = (name) => ({ function: { name, parameters: { type: "object", required: [] } } });
const source = {
  index: 0,
  episode: {
    transcript: [],
    verdict: { passed: false },
    userScenario: "PRIVATE_SCENARIO",
    checks: "PRIVATE_CRITERIA",
  },
};
const assignment = (arm) => ({
  label: `${arm}-r0-case-0`,
  arm,
  repetition: 0,
  index: 0,
  alias: "case-0",
});
const context = { policy: "PUBLIC_POLICY", tools: [] };

test("experience selection keeps public traces and selected probe results; blind gets none", () => {
  const attempts = [
    {
      assignment: assignment("interactive"),
      result: {
        afterPassed: false,
        status: "stopped",
        nativeActions: 1,
        events: [{ type: "action", response: { content: "OBSERVED_PROBE" } }],
      },
      calls: [{}],
      plans: [],
    },
  ];
  const evidence = learningEvidence([{ alias: "case-0", ...source }], attempts);
  const experienced = JSON.stringify(controllerPacket("experience", context, evidence));
  const blind = JSON.stringify(controllerPacket("blind", context, evidence));
  assert.ok(experienced.includes("OBSERVED_PROBE"));
  assert.ok(!blind.includes("OBSERVED_PROBE"));
  for (const secret of ["PRIVATE_SCENARIO", "PRIVATE_CRITERIA"])
    assert.ok(!experienced.includes(secret));
  assert.equal(evidence.cases.length, 1);
});

test("controller compiler rejection gets at most one mechanical revision without task feedback", async () => {
  let calls = 0;
  const provider = {
    call: async (request, options) => {
      calls++;
      assert.equal(options.maxTokens, 4096);
      const packet = JSON.parse(request.messages[0].content.split("\nReturn assessment")[0]);
      if (calls === 2) assert.equal(packet.compilerRepair.valid, false);
      return {
        id: `c${calls}`,
        usd: 0.01,
        wallMs: 1,
        stopReason: "end_turn",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              assessment: "test",
              program: {
                delivery: "system",
                instructions:
                  calls === 1 ? "" : "Check observable results before assuming success.",
              },
            }),
          },
        ],
      };
    },
  };
  const generated = await generateController(provider, "blind", context, {});
  assert.equal(calls, 2);
  assert.equal(generated.generated.valid, true);
  assert.equal(generated.usd, 0.02);
});

test("both conditions receive the same larger token limit and brief rationale instruction", async () => {
  for (const arm of ["blind", "experience"]) {
    let requests = 0;
    const attempt = await runControllerAttempt({
      assignment: assignment(arm),
      controller: "GENERATED_ONLY",
      source,
      bridgeFactory: () => ({
        request: async (r) =>
          r.method === "reset"
            ? { policy: "PUBLIC", agentTools: [def("check")], userTools: [] }
            : { passed: false, replayMatch: true, unrelatedPreserved: true },
        close() {},
      }),
      provider: {
        call: async (request, options) => {
          requests++;
          assert.equal(options.maxTokens, 2048);
          assert.ok(request.system.endsWith("GENERATED_ONLY"));
          assert.ok(
            JSON.parse(request.messages[0].content).instruction.includes("at most 60 words"),
          );
          assert.ok(
            !Object.hasOwn(request.output_config.format.schema.properties.actions, "maxItems"),
          );
          return {
            id: "x",
            usd: 0.01,
            wallMs: 1,
            stopReason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ rationale: "Stop", actions: [] }) }],
          };
        },
      },
    });
    assert.equal(requests, 1);
    assert.equal(attempt.assignment.arm, arm);
    assert.equal(attempt.result.afterPassed, false);
  }
});

test("case identity, rather than completion order, determines the comparison", () => {
  const make = (arm, index, passed) => ({
    assignment: { ...assignment(arm), label: `${arm}-${index}`, index },
    result: { afterPassed: passed, status: "stopped" },
    cost: { modelCalls: 1, nativeActions: 1, providerUsd: 0.01 },
  });
  const rows = [
    make("blind", 1, false),
    make("experience", 0, true),
    make("blind", 0, true),
    make("experience", 1, false),
  ];
  const summary = summarizeLearning(
    rows.map((r) => r.assignment),
    rows,
  );
  assert.deepEqual(
    summary.arms[0].cases.map((c) => c.index),
    [0, 1],
  );
  assert.deepEqual(
    summary.arms[1].cases.map((c) => c.index),
    [0, 1],
  );
  assert.equal(summary.experienceMinusBlind, 0);
});
