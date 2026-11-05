import assert from "node:assert/strict";
import { createBridge } from "./bridge.mjs";
import { diagnosticActionCatalog, validateDiagnosticActions } from "./diagnostic-actions.mjs";

// Future-protocol component. The frozen rediscovery2 study does not import this module.
// selectAction receives public tool contracts, prior probe responses and a binary starting grade.
// It returns one role-qualified action, or null to finish. Provider accounting belongs to the caller.
export async function runDiagnosticSession({
  alias,
  source,
  selectAction,
  maxActions = 6,
  maxDecisions = 8,
  bridgeFactory = createBridge,
}) {
  assert.equal(typeof alias, "string");
  assert.ok(alias.length > 0 && alias.length <= 80);
  assert.ok(Number.isInteger(source?.index) && source.index >= 0);
  assert.ok(Array.isArray(source?.episode?.transcript));
  assert.equal(typeof source.episode.verdict?.passed, "boolean");
  assert.equal(typeof selectAction, "function");
  assert.ok(Number.isInteger(maxActions) && maxActions >= 1 && maxActions <= 6);
  assert.ok(Number.isInteger(maxDecisions) && maxDecisions >= maxActions && maxDecisions <= 12);
  const replay = structuredClone(source.episode.transcript.filter((r) => r.type === "tool"));
  const expectedPassed = source.episode.verdict.passed;
  const result = {
    case: alias,
    status: "initializing",
    beforePassed: null,
    afterPassed: null,
    nativeActions: 0,
    decisions: 0,
    limits: { actions: maxActions, decisions: maxDecisions },
    events: [],
  };
  let bridge;
  let phase = "replay";
  try {
    bridge = bridgeFactory();
    const context = await bridge.request({ method: "reset", index: source.index });
    for (const t of replay) {
      assert.ok(["actor", "user"].includes(t.seat), "Unknown recorded tool seat");
      const observed = await bridge.request({
        method: "call",
        role: t.seat === "actor" ? "assistant" : "user",
        name: t.name,
        arguments: t.arguments,
      });
      assert.equal(observed.content, t.content, "Parent tool response changed during replay");
      assert.equal(observed.error, t.error, "Parent tool error changed during replay");
    }
    const before = await bridge.request({ method: "judge" });
    assert.equal(before.replayMatch, true, "Parent native replay failed");
    assert.equal(before.unrelatedPreserved, true, "Parent changed unrelated state");
    assert.equal(before.passed, expectedPassed, "Parent grade changed during replay");
    result.beforePassed = before.passed;
    const tools = diagnosticActionCatalog(context).map((tool) => ({
      ...tool,
      description:
        (tool.role === "assistant" ? context.agentTools : context.userTools).find(
          (t) => t.function.name === tool.name,
        ).function.description ?? "",
    }));
    result.status = "running";
    while (result.nativeActions < maxActions && result.decisions < maxDecisions) {
      phase = "selection";
      result.decisions++;
      // Explicit projection: reset also contains a private scenario/history, and judge has hidden
      // criterion-level checks. None of those fields belongs in the selector's view.
      const choice = await selectAction(
        structuredClone({
          case: alias,
          policy: context.policy,
          tools,
          beforePassed: result.beforePassed,
          decision: result.decisions,
          remainingActions: maxActions - result.nativeActions,
          remainingDecisions: maxDecisions - result.decisions,
          events: result.events,
        }),
      );
      if (choice === null) {
        result.status = "stopped";
        result.events.push({ type: "stop", decision: result.decisions });
        break;
      }
      const checked = validateDiagnosticActions([choice], context);
      if (!checked.valid) {
        result.events.push({
          type: "rejection",
          decision: result.decisions,
          submitted: structuredClone(choice ?? null),
          errors: checked.errors,
        });
        continue;
      }
      const action = checked.actions[0];
      const event = {
        type: "action",
        decision: result.decisions,
        action: structuredClone(choice),
        status: "requested",
      };
      result.events.push(event);
      result.nativeActions++;
      phase = "native-action";
      const observed = await bridge.request({
        method: "call",
        role: action.role,
        name: action.name,
        arguments: JSON.parse(action.argumentsJson),
      });
      assert.equal(typeof observed.content, "string");
      assert.equal(typeof observed.error, "boolean");
      event.status = "returned";
      // Preserve complete native responses. The next decision arrives only after this response.
      event.response = { content: observed.content, error: observed.error };
    }
    if (result.status === "running")
      result.status = result.nativeActions === maxActions ? "action-limit" : "decision-limit";
    phase = "verification";
    const after = await bridge.request({ method: "judge" });
    assert.equal(typeof after.passed, "boolean");
    assert.equal(after.replayMatch, true, "Diagnostic native replay failed");
    assert.equal(after.unrelatedPreserved, true, "Diagnostic changed unrelated state");
    result.afterPassed = after.passed;
  } catch (error) {
    // Native transport failure may follow a mutation: retain the submitted action and do not retry.
    result.status = "error";
    result.error = { phase, message: error instanceof Error ? error.message : String(error) };
  } finally {
    bridge?.close();
  }
  return result;
}
