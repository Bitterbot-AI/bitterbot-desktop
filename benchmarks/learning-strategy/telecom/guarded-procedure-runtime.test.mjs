import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPublicIdentity,
  resolveArguments,
  validateProcedure,
  evaluatePredicate,
  createProcedureSelector,
  runGuardedAttempt,
  procedureRequest,
  qualificationGate,
} from "./guarded-procedure-runtime.mjs";

const tool = (name, effect, required = []) => ({
  tool: `assistant.${name}`,
  name,
  role: "assistant",
  effect,
  parameters: { type: "object", required },
});

test("missing identity abstains while retaining native failed outcome and denominator", async () => {
  let calls = 0;
  const result = await runGuardedAttempt({
    assignment: { arm: "compiled", label: "missing", alias: "missing", index: 0 },
    source: { index: 0, episode: { transcript: [], verdict: { passed: false } } },
    artifact: program(),
    context,
    bridgeFactory: () => ({
      request: async (r) => {
        calls++;
        if (r.method === "reset") return { policy: "public", agentTools: [], userTools: [] };
        assert.equal(r.method, "judge");
        return { passed: false, replayMatch: true, unrelatedPreserved: true };
      },
      close() {},
    }),
  });
  assert.match(result.bindingError, /No public customer lookup/);
  assert.equal(result.result.afterPassed, false);
  assert.equal(result.result.nativeActions, 0);
  assert.equal(calls, 3);
});

test("qualification does not discard missing identities or tolerate healthy regressions", () => {
  const artifacts = [{ candidate: "a", valid: true }],
    primary = [
      { group: "compiled:a", errors: 0, repaired: 12 },
      { group: "advice:a", errors: 0, repaired: 10 },
    ],
    panel = [
      {
        candidate: "a",
        failed: 28,
        repaired: 14,
        healthy: 16,
        preserved: 16,
        healthyWrites: 0,
        errors: 0,
        selfVerifiedFalsePositives: 0,
      },
    ];
  assert.equal(qualificationGate(artifacts, primary, panel), true);
  panel[0].repaired = 13;
  assert.equal(qualificationGate(artifacts, primary, panel), false);
  panel[0].repaired = 14;
  panel[0].healthyWrites = 1;
  assert.equal(qualificationGate(artifacts, primary, panel), false);
  panel[0].healthyWrites = 0;
  artifacts[0].valid = false;
  assert.equal(qualificationGate(artifacts, primary, panel), false);
});
const context = {
  policy: "public",
  tools: [
    tool("outcome", "READ"),
    tool("inspect", "READ", ["id"]),
    tool("repair", "WRITE", ["line_id"]),
  ],
};
const pred = (step, format, path, value) => ({
  step,
  format,
  path,
  valueJson: JSON.stringify(value),
});
const step = (id, name, args = {}, when = [], successWhen = []) => ({
  id,
  tool: `assistant.${name}`,
  argumentsJson: JSON.stringify(args),
  when,
  successWhen,
});
const program = () => ({
  description: "A fixture procedure, not a telecom recipe",
  steps: [
    step("initial", "outcome", {}, [], [pred("initial", "text", "", "working")]),
    step("inspect", "inspect", { id: "${lineId}" }),
    step("repair", "repair", { line_id: "${lineId}" }, [
      pred("inspect", "json", "/enabled", false),
    ]),
    step("final", "outcome", {}, [], [pred("final", "text", "", "working")]),
  ],
});
const identity = () => ({
  transcript: [
    {
      type: "tool",
      seat: "actor",
      name: "get_customer_by_phone",
      arguments: { phone_number: "test-phone" },
      content: JSON.stringify({ customer_id: "other-customer", line_ids: ["other-line"] }),
      error: false,
    },
    {
      type: "tool",
      seat: "actor",
      name: "get_details_by_id",
      arguments: { id: "other-line" },
      content: JSON.stringify({ line_id: "other-line", phone_number: "test-phone" }),
      error: false,
    },
  ],
  verdict: { passed: false },
});
test("public binding follows lookup and line association and rejects ambiguity", () => {
  const e = identity();
  assert.deepEqual(bindPublicIdentity(e), {
    customerId: "other-customer",
    lineId: "other-line",
    phoneNumber: "test-phone",
  });
  e.transcript.push({ ...e.transcript[0], arguments: { phone_number: "another-phone" } });
  assert.throws(() => bindPublicIdentity(e), /Ambiguous/);
  const broken = identity();
  broken.transcript[0].content = JSON.stringify({ customer_id: "other-customer", line_ids: [] });
  assert.throws(() => bindPublicIdentity(broken), /linked/);
});
test("argument binding does not evaluate code and refuses arbitrary variables", () => {
  assert.deepEqual(
    resolveArguments('{"id":"${lineId}","value":"x"}', { lineId: "arbitrary-line" }),
    { id: "arbitrary-line", value: "x" },
  );
  assert.throws(() => resolveArguments('{"id":"${process.env.SECRET}"}', {}));
  assert.throws(() => resolveArguments('{"__proto__":{}}', {}));
});
test("compiler requires guarded mutations, earlier read evidence and matching outcome checks", () => {
  assert.ok(validateProcedure(program(), context));
  for (const mutate of [
    (p) => (p.steps[2].when = []),
    (p) => (p.steps[2].when[0].step = "later"),
    (p) => (p.steps[2].argumentsJson = '{"line_id":"guessed-line"}'),
    (p) => (p.steps.at(-1).successWhen = []),
    (p) => (p.steps[2].successWhen = [pred("inspect", "json", "/enabled", true)]),
  ]) {
    const p = program();
    mutate(p);
    assert.throws(() => validateProcedure(p, context));
  }
});
test("predicates preserve false vs missing and reject duplicate text fields and errors", () => {
  const p = pred("x", "json", "/enabled", false);
  assert.equal(evaluatePredicate(p, { x: { content: '{"enabled":false}', error: false } }), true);
  assert.equal(evaluatePredicate(p, { x: { content: "{}", error: false } }), "unknown");
  assert.equal(
    evaluatePredicate(p, { x: { content: '{"enabled":false}', error: true } }),
    "unknown",
  );
  const line = pred("x", "line", "Mode", "Off");
  assert.equal(
    evaluatePredicate(line, { x: { content: "Mode: Off\nOther: Yes", error: false } }),
    true,
  );
  assert.equal(
    evaluatePredicate(line, { x: { content: "Mode: Off\nMode: On", error: false } }),
    "unknown",
  );
});
async function execute({ working = false, missing = false, throwRepair = false } = {}) {
  const actions = [],
    selector = createProcedureSelector(program(), { lineId: "bound-line" });
  let events = [];
  for (let decision = 1; decision <= 6; decision++) {
    const action = await selector.select({ events });
    if (!action) break;
    actions.push(action.tool);
    if (action.tool === "assistant.repair") {
      if (throwRepair) break;
      working = true;
    }
    events.push({
      type: "action",
      action,
      status: "returned",
      response: {
        content:
          action.tool === "assistant.outcome"
            ? working
              ? "working"
              : "broken"
            : action.tool === "assistant.inspect"
              ? missing
                ? "{}"
                : JSON.stringify({ enabled: working })
              : "changed",
        error: false,
      },
    });
  }
  return { actions, state: selector.finish(events) };
}
test("an already-working input stops at its first check without mutations", async () => {
  const r = await execute({ working: true });
  assert.deepEqual(r.actions, ["assistant.outcome"]);
  assert.equal(r.state.selfVerified, true);
});
test("a failed input is inspected, conditionally repaired and verified", async () => {
  const r = await execute();
  assert.deepEqual(r.actions, [
    "assistant.outcome",
    "assistant.inspect",
    "assistant.repair",
    "assistant.outcome",
  ]);
  assert.equal(r.state.selfVerified, true);
});
test("unknown guards and ambiguous dispatch stop without fallback or retry", async () => {
  const missing = await execute({ missing: true });
  assert.equal(missing.state.status, "unknown-guard");
  assert.ok(!missing.actions.includes("assistant.repair"));
  const interrupted = await execute({ throwRepair: true });
  assert.equal(interrupted.state.status, "interrupted");
  assert.equal(interrupted.actions.filter((a) => a === "assistant.repair").length, 1);
});
test("the final observation is ingested even when the native action limit ends selection", async () => {
  const s = createProcedureSelector(program(), { lineId: "bound" }),
    events = [];
  for (let i = 0; i < 4; i++) {
    const action = await s.select({ events });
    events.push({
      type: "action",
      action,
      status: "returned",
      response: {
        content:
          i === 0 ? "broken" : i === 1 ? '{"enabled":false}' : i === 2 ? "changed" : "working",
        error: false,
      },
    });
  }
  assert.equal(s.finish(events).selfVerified, true);
});
test("provider schema omits unsupported numeric array limits and retains local constraints", () => {
  const request = procedureRequest(context, {});
  assert.ok(!JSON.stringify(request.output_config).includes("maxItems"));
  assert.ok(JSON.stringify(request).includes("2..6 steps"));
});
test("compiled execution does not need a provider and preserves native verification", async () => {
  let working = false;
  const e = identity();
  e.transcript = [];
  // Binding is deliberately tested independently above; use a matching replay fixture here.
  e.transcript = identity().transcript;
  const responses = new Map(e.transcript.map((t) => [t.name, t.content]));
  const bridgeFactory = () => ({
    request: async (r) => {
      if (r.method === "reset")
        return {
          policy: "public",
          agentTools: context.tools.map((t) => ({
            function: { name: t.name, parameters: t.parameters },
          })),
          userTools: [],
        };
      if (r.method === "judge")
        return { passed: working, replayMatch: true, unrelatedPreserved: true };
      if (responses.has(r.name)) return { content: responses.get(r.name), error: false };
      if (r.name === "repair") working = true;
      return {
        content:
          r.name === "outcome"
            ? working
              ? "working"
              : "broken"
            : r.name === "inspect"
              ? JSON.stringify({ enabled: working })
              : "changed",
        error: false,
      };
    },
    close() {},
  });
  const r = await runGuardedAttempt({
    assignment: { arm: "compiled", label: "test", alias: "test", index: 0 },
    source: { index: 0, episode: e },
    artifact: program(),
    context,
    bridgeFactory,
  });
  assert.equal(r.result.afterPassed, true);
  assert.equal(r.procedureState.selfVerified, true);
  assert.equal(r.cost.modelCalls, 0);
});
