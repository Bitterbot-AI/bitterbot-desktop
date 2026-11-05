import assert from "node:assert/strict";
import test from "node:test";
import { runDiagnosticSession } from "./diagnostic-session.mjs";

const action = (tool, args = {}) => ({ tool, argumentsJson: JSON.stringify(args) });
const definition = (name) => ({
  function: { name, description: name, parameters: { type: "object", required: [] } },
});
function fixture({ saver = true, transcript = [], failCall = false, changedReplay = false } = {}) {
  const calls = [];
  let closed = 0;
  const bridgeFactory = () => ({
    async request(request) {
      calls.push(request);
      if (request.method === "reset")
        return {
          policy: "Public policy",
          agentTools: [definition("account_check"), definition("transfer_to_human_agents")],
          userTools: [definition("check_saver"), definition("toggle_saver")],
          userScenario: { secret: "PRIVATE_SCENARIO" },
          history: [{ secret: "PRIVATE_HISTORY" }],
        };
      if (request.method === "judge")
        return {
          passed: !saver,
          replayMatch: true,
          unrelatedPreserved: true,
          checks: ["HIDDEN_CRITERION"],
        };
      if (failCall) throw Error("Transport ended after dispatch");
      if (request.name === "toggle_saver") saver = !saver;
      return { content: changedReplay ? "changed" : saver ? "on" : "off", error: false };
    },
    close() {
      closed++;
    },
  });
  return {
    source: { index: 0, episode: { transcript, verdict: { passed: !saver } } },
    bridgeFactory,
    calls,
    closed: () => closed,
  };
}

test("the same selector changes its next action based on the actual first observation", async () => {
  for (const saver of [true, false]) {
    const f = fixture({ saver });
    const result = await runDiagnosticSession({
      ...f,
      alias: "case-a",
      selectAction: async (view) => {
        const last = view.events.at(-1);
        if (!last) return action("user.check_saver");
        if (last.action.tool === "user.check_saver" && last.response.content === "on")
          return action("user.toggle_saver");
        return null;
      },
    });
    assert.equal(result.afterPassed, true);
    assert.equal(result.beforePassed, !saver);
    assert.equal(result.nativeActions, saver ? 2 : 1);
    assert.equal(f.calls.filter((c) => c.name === "toggle_saver").length, saver ? 1 : 0);
    assert.equal(f.closed(), 1);
  }
});

test("selector projection excludes private reset fields and hidden grading criteria", async () => {
  const f = fixture();
  let view;
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    selectAction: async (value) => {
      view = value;
      return null;
    },
  });
  const text = JSON.stringify({ view, result });
  for (const secret of ["PRIVATE_SCENARIO", "PRIVATE_HISTORY", "HIDDEN_CRITERION"])
    assert.ok(!text.includes(secret));
  assert.ok(!view.tools.some((t) => t.tool.includes("transfer_to_human_agents")));
  assert.equal(view.tools.find((t) => t.tool === "user.check_saver").description, "check_saver");
});

test("role rejection consumes a decision and is corrected only by a new selector decision", async () => {
  const f = fixture();
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    maxActions: 1,
    maxDecisions: 2,
    selectAction: async (view) => {
      if (view.decision === 1) return action("assistant.toggle_saver");
      assert.deepEqual(view.events[0].errors[0].availableForName, ["user.toggle_saver"]);
      assert.equal(f.calls.filter((c) => c.method === "call").length, 0);
      return action("user.toggle_saver");
    },
  });
  assert.equal(result.status, "action-limit");
  assert.equal(result.afterPassed, true);
  assert.equal(result.decisions, 2);
  assert.equal(result.nativeActions, 1);
  assert.equal(f.calls.filter((c) => c.method === "call").length, 1);
});

test("changed parent replay aborts before the selector is called", async () => {
  const f = fixture({
    changedReplay: true,
    transcript: [
      {
        type: "tool",
        seat: "user",
        name: "check_saver",
        arguments: {},
        content: "on",
        error: false,
      },
    ],
  });
  let selected = 0;
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    selectAction: async () => {
      selected++;
      return null;
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.phase, "replay");
  assert.equal(selected, 0);
  assert.equal(result.afterPassed, null);
  assert.equal(f.closed(), 1);
});

test("an ambiguous native failure retains the dispatched action without retry or a repair claim", async () => {
  const f = fixture({ failCall: true });
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    selectAction: async () => action("user.toggle_saver"),
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.phase, "native-action");
  assert.equal(result.events[0].status, "requested");
  assert.equal(result.nativeActions, 1);
  assert.equal(result.afterPassed, null);
  assert.equal(f.calls.filter((c) => c.method === "call").length, 1);
  assert.equal(f.closed(), 1);
});

test("invalid decisions terminate at the decision limit and native actions have a separate limit", async () => {
  for (const valid of [false, true]) {
    const f = fixture();
    const result = await runDiagnosticSession({
      ...f,
      alias: "case-a",
      maxActions: 2,
      maxDecisions: 3,
      selectAction: async () => action(valid ? "user.check_saver" : "unknown.check_saver"),
    });
    assert.equal(result.status, valid ? "action-limit" : "decision-limit");
    assert.equal(result.decisions, valid ? 2 : 3);
    assert.equal(result.nativeActions, valid ? 2 : 0);
    assert.equal(result.afterPassed, false);
    assert.equal(f.closed(), 1);
  }
});

test("selector mutation cannot rewrite retained evidence or the native tool catalog", async () => {
  const f = fixture();
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    selectAction: async (view) => {
      if (view.decision === 1) return action("user.check_saver");
      view.events[0].response.content = "forged";
      view.tools[0].tool = "user.forged";
      return action("user.forged");
    },
    maxActions: 2,
    maxDecisions: 2,
  });
  assert.equal(result.events[0].response.content, "on");
  assert.equal(result.events[1].type, "rejection");
  assert.equal(result.nativeActions, 1);
});

test("selector errors close the sandbox and invalid limits dispatch nothing", async () => {
  const f = fixture();
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    selectAction: async () => {
      throw Error("Provider interrupted");
    },
  });
  assert.equal(result.error.phase, "selection");
  assert.equal(result.decisions, 1);
  assert.equal(f.closed(), 1);
  const unused = fixture();
  await assert.rejects(
    runDiagnosticSession({
      ...unused,
      alias: "case-a",
      maxActions: 7,
      selectAction: async () => null,
    }),
  );
  assert.equal(unused.calls.length, 0);
});

test("a repair that changes an unrelated account receives no success credit", async () => {
  const f = fixture();
  const originalFactory = f.bridgeFactory;
  let judgments = 0;
  f.bridgeFactory = () => {
    const bridge = originalFactory();
    return {
      async request(request) {
        const result = await bridge.request(request);
        if (request.method === "judge" && ++judgments === 2)
          return { ...result, unrelatedPreserved: false };
        return result;
      },
      close: () => bridge.close(),
    };
  };
  const result = await runDiagnosticSession({
    ...f,
    alias: "case-a",
    maxActions: 1,
    selectAction: async () => action("user.toggle_saver"),
  });
  assert.equal(result.status, "error");
  assert.equal(result.error.phase, "verification");
  assert.match(result.error.message, /changed unrelated state/);
  assert.equal(result.afterPassed, null);
  assert.equal(result.events[0].response.content, "off");
  assert.equal(f.closed(), 1);
});
