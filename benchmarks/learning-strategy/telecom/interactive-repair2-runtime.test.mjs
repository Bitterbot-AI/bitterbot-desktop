import assert from "node:assert/strict";
import test from "node:test";
import {
  runRepairAttempt,
  verifyRepairSequence,
  summarizeRepairs,
} from "./interactive-repair2-runtime.mjs";

const action = (tool, args = {}) => ({ tool, argumentsJson: JSON.stringify(args) });
const definition = (name) => ({
  function: { name, description: name, parameters: { type: "object", required: [] } },
});
function fixture(arm) {
  const assignment = { label: `${arm}-r0-case-0`, arm, repetition: 0, index: 0, alias: "case-0" };
  const source = { index: 0, episode: { transcript: [], verdict: { passed: false } } };
  const bridgeFactory = () => {
    let account = false,
      device = false;
    return {
      async request(r) {
        if (r.method === "reset")
          return {
            policy: "PUBLIC",
            agentTools: [definition("check"), definition("enable")],
            userTools: [definition("toggle")],
            userScenario: "PRIVATE_SCENARIO",
            history: "PRIVATE_HISTORY",
          };
        if (r.method === "judge")
          return {
            passed: account && device,
            replayMatch: true,
            unrelatedPreserved: true,
            checks: "PRIVATE_CRITERIA",
          };
        if (r.name === "enable") account = true;
        if (r.name === "toggle") device = !device;
        return { content: JSON.stringify({ account, device }), error: false };
      },
      close() {},
    };
  };
  return { assignment, source, bridgeFactory };
}
function provider(select) {
  const requests = [];
  return {
    requests,
    async call(request, options) {
      assert.ok(!Object.hasOwn(request.output_config.format.schema.properties.actions, "maxItems"));
      requests.push({ request, options });
      const packet = JSON.parse(request.messages[0].content);
      for (const secret of ["PRIVATE_SCENARIO", "PRIVATE_HISTORY", "PRIVATE_CRITERIA"])
        assert.ok(!JSON.stringify(packet).includes(secret));
      return {
        id: `response-${requests.length}`,
        usd: 0.01,
        wallMs: 1,
        stopReason: "end_turn",
        content: [
          { type: "text", text: JSON.stringify({ rationale: "test", actions: select(packet) }) },
        ],
      };
    },
  };
}

test("batch commits one plan before executing any action and never requests feedback", async () => {
  const p = provider(({ view }) => {
    assert.deepEqual(view.events, []);
    return [action("assistant.enable"), action("user.toggle")];
  });
  const attempt = await runRepairAttempt({ ...fixture("batch"), provider: p });
  assert.equal(p.requests.length, 1);
  assert.equal(attempt.result.afterPassed, true);
  assert.equal(attempt.cost.nativeActions, 2);
});

test("removing the unsupported wire keyword preserves local action-count enforcement", async () => {
  for (const arm of ["batch", "interactive"]) {
    const p = provider(() =>
      Array.from({ length: arm === "batch" ? 7 : 2 }, () => action("assistant.enable")),
    );
    const attempt = await runRepairAttempt({ ...fixture(arm), provider: p });
    assert.equal(attempt.result.status, "error");
    assert.equal(attempt.result.error.phase, "selection");
    assert.equal(attempt.result.nativeActions, 0);
    assert.equal(attempt.calls.length, 1);
    assert.equal(attempt.cost.providerUsd, 0.01);
  }
});

test("interactive sees complete preceding responses before choosing the next action", async () => {
  const p = provider(({ view }) => {
    const last = view.events.at(-1);
    if (!last) return [action("assistant.check")];
    const state = JSON.parse(last.response.content);
    if (!state.account) return [action("assistant.enable")];
    if (!state.device) return [action("user.toggle")];
    return [];
  });
  const attempt = await runRepairAttempt({ ...fixture("interactive"), provider: p });
  assert.equal(p.requests.length, 4);
  assert.equal(attempt.result.afterPassed, true);
  assert.equal(attempt.cost.nativeActions, 3);
});

test("a wrong-role batch action rejects the whole sequence before mutation", async () => {
  const p = provider(() => [action("assistant.enable"), action("assistant.toggle")]);
  const attempt = await runRepairAttempt({ ...fixture("batch"), provider: p });
  assert.equal(attempt.result.nativeActions, 0);
  assert.equal(attempt.result.afterPassed, false);
  assert.equal(attempt.plans[0].validation.valid, false);
});

test("interactive role rejection is visible, consumes a decision and can be corrected", async () => {
  const p = provider(({ view }) => {
    if (view.decision === 1) return [action("assistant.toggle")];
    if (view.decision === 2) {
      assert.equal(view.events[0].type, "rejection");
      return [action("user.toggle")];
    }
    if (view.decision === 3) return [action("assistant.enable")];
    return [];
  });
  const attempt = await runRepairAttempt({ ...fixture("interactive"), provider: p });
  assert.equal(attempt.result.afterPassed, true);
  assert.equal(attempt.result.nativeActions, 2);
  assert.equal(attempt.result.decisions, 4);
});

test("repair capsule retains all omission trials and distinguishes necessary mutations from checks", async () => {
  const f = fixture("batch"),
    p = provider(() => [
      action("assistant.check"),
      action("assistant.enable"),
      action("user.toggle"),
    ]);
  const attempt = await runRepairAttempt({ ...f, provider: p });
  const record = await verifyRepairSequence({ ...f, attempt });
  assert.equal(record.status, "verified");
  assert.equal(record.rows.length, 4);
  assert.deepEqual(record.necessaryOnInput, [1, 2]);
  assert.equal(record.generalizationEstablished, false);
});

test("all assigned failures remain in denominators and duplicate or missing attempts are rejected", async () => {
  const f = fixture("batch"),
    g = fixture("interactive");
  const a = await runRepairAttempt({
    ...f,
    provider: provider(() => [action("assistant.enable"), action("user.toggle")]),
  });
  const b = await runRepairAttempt({ ...g, provider: provider(() => []) });
  const assignments = [f.assignment, g.assignment];
  const result = summarizeRepairs(assignments, [a, b]);
  assert.equal(result.arms[1].assigned, 1);
  assert.equal(result.arms[1].repaired, 0);
  assert.equal(result.mechanismGatePassed, false);
  assert.throws(() => summarizeRepairs(assignments, [a]));
  assert.throws(() => summarizeRepairs(assignments, [a, a]));
});
