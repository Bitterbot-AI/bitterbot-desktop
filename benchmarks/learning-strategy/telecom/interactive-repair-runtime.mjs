import assert from "node:assert/strict";
import { validateDiagnosticActions } from "./diagnostic-actions.mjs";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import { publicTrace, parseResponse } from "./rediscovery2-engineer.mjs";

export const ARMS = ["batch", "interactive"];
export const COMMON =
  "You are investigating a failed synthetic customer-support execution. Repair its final state using the provided native tools and public evidence. Diagnose from observations, preserve unrelated state, and verify the requested service. No particular cause or repair is supplied. This is an isolated development copy: role-qualified account and device actions are both available to the researcher. Normal agents still require role separation and customer consent. The original trace is historical evidence; prefer current observations when state may have changed. Hidden criteria and private customer scenario are unavailable. A final binary native grade is measured after your attempt; it is never exposed between actions. Do not invent results or use the case alias as a diagnostic clue.";

export function repairRequest(arm, evidence, view) {
  assert.ok(ARMS.includes(arm));
  const action = {
    type: "object",
    additionalProperties: false,
    required: ["tool", "argumentsJson"],
    properties: {
      tool: { type: "string", enum: view.tools.map((t) => t.tool) },
      argumentsJson: { type: "string" },
    },
  };
  return {
    system: COMMON,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          evidence,
          view,
          instruction:
            arm === "batch"
              ? "Return a single fixed sequence of zero to six native actions. It will execute in order without conditional branching or later revision. The whole plan is validated before execution. Use an empty list to stop. Explain briefly why these actions could repair the failure; do not claim they succeeded."
              : "Choose zero or one next native action. You will see its complete response before choosing again. Use an empty list to stop. Explain briefly why the next action is useful; do not claim an unobserved result. You have six native actions and eight decisions in total, including rejected submissions.",
        }),
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["rationale", "actions"],
          properties: {
            rationale: { type: "string" },
            actions: { type: "array", items: action, maxItems: arm === "batch" ? 6 : 1 },
          },
        },
      },
    },
    cache_control: { type: "ephemeral" },
  };
}

function parsePlan(response, arm) {
  const value = parseResponse(response);
  assert.equal(Object.keys(value).sort().join(","), "actions,rationale");
  assert.equal(typeof value.rationale, "string");
  assert.ok(Array.isArray(value.actions));
  assert.ok(value.actions.length <= (arm === "batch" ? 6 : 1));
  return value;
}

export async function runRepairAttempt({ assignment, source, provider, bridgeFactory }) {
  const { arm, label, alias } = assignment;
  assert.ok(ARMS.includes(arm));
  const evidence = {
    case: alias,
    startingPassed: source.episode.verdict.passed,
    traceTruncated: false,
    timeline: publicTrace(source.episode),
  };
  const calls = [],
    plans = [];
  let cursor = 0,
    batch;
  const result = await runDiagnosticSession({
    alias,
    source,
    bridgeFactory,
    selectAction: async (view) => {
      if (arm === "batch" && batch !== undefined) return batch[cursor++] ?? null;
      const maxTokens = arm === "batch" ? 2048 : 1024;
      const response = await provider.call(repairRequest(arm, evidence, view), {
        tag: `${label}-decision-${view.decision}-case-${source.index}`,
        maxTokens,
      });
      calls.push(response);
      const plan = parsePlan(response, arm);
      plans.push({ decision: view.decision, responseId: response.id, ...plan });
      if (arm === "batch") {
        // Validate the whole batch before any mutation, using exactly the visible contracts.
        const context = { agentTools: [], userTools: [] };
        for (const tool of view.tools)
          context[tool.role === "assistant" ? "agentTools" : "userTools"].push({
            function: { name: tool.name, parameters: tool.parameters },
          });
        const validation = plan.actions.length
          ? validateDiagnosticActions(plan.actions, context)
          : { valid: true, errors: [], actions: [] };
        plans.at(-1).validation = validation;
        batch = validation.valid ? plan.actions : [];
        return batch[cursor++] ?? null;
      }
      return plan.actions[0] ?? null;
    },
  });
  return {
    assignment,
    result,
    plans,
    calls,
    cost: {
      providerUsd: calls.reduce((s, c) => s + c.usd, 0),
      modelCalls: calls.length,
      providerWallMs: calls.reduce((s, c) => s + c.wallMs, 0),
      nativeActions: result.nativeActions,
    },
  };
}

// A replayable evidence capsule, deliberately scoped to its exact failed input.
// Omission results establish sequence-local necessity, not a universal causal rule.
export async function verifyRepairSequence({ assignment, source, attempt, bridgeFactory }) {
  assert.equal(attempt.result.afterPassed, true);
  const actions = attempt.result.events
    .filter((e) => e.type === "action")
    .map((e) => {
      assert.equal(e.status, "returned");
      return e.action;
    });
  const variants = [null, ...actions.map((_, i) => i)],
    rows = [];
  for (const omitted of variants) {
    const sequence = actions.filter((_, i) => i !== omitted);
    let cursor = 0;
    const result = await runDiagnosticSession({
      alias: assignment.alias,
      source,
      bridgeFactory,
      selectAction: async () => sequence[cursor++] ?? null,
    });
    rows.push({ omitted, result });
  }
  const full = rows[0].result;
  const verified = full.afterPassed === true && rows.every((r) => r.result.status !== "error");
  return {
    assignment,
    actions,
    rows,
    status: verified ? "verified" : "unqualified",
    necessaryOnInput: verified
      ? rows
          .filter((r) => r.omitted !== null && r.result.afterPassed === false)
          .map((r) => r.omitted)
      : [],
    sharing: "private",
    scope: "exact-failed-input-and-fixed-sequence",
    generalizationEstablished: false,
    recipientBenefitEstablished: false,
  };
}

export function summarizeRepairs(assignments, attempts) {
  assert.equal(attempts.length, assignments.length);
  assert.equal(new Set(attempts.map((a) => a.assignment.label)).size, assignments.length);
  for (const a of assignments)
    assert.deepEqual(attempts.find((t) => t.assignment.label === a.label)?.assignment, a);
  const arms = ARMS.map((arm) => {
    const rows = attempts.filter((a) => a.assignment.arm === arm);
    return {
      arm,
      assigned: rows.length,
      repaired: rows.filter((a) => a.result.afterPassed === true).length,
      errors: rows.filter((a) => a.result.status === "error").length,
      invalidSubmissions: rows.reduce(
        (s, a) =>
          s +
          a.result.events.filter((e) => e.type === "rejection").length +
          a.plans.filter((p) => p.validation?.valid === false).length,
        0,
      ),
      modelCalls: rows.reduce((s, a) => s + a.cost.modelCalls, 0),
      nativeActions: rows.reduce((s, a) => s + a.cost.nativeActions, 0),
      providerUsd: rows.reduce((s, a) => s + a.cost.providerUsd, 0),
      cases: [...new Set(rows.map((a) => a.assignment.index))].map((index) => ({
        index,
        assigned: rows.filter((a) => a.assignment.index === index).length,
        repaired: rows.filter((a) => a.assignment.index === index && a.result.afterPassed === true)
          .length,
      })),
    };
  });
  const [batch, interactive] = arms;
  return {
    arms,
    interactiveMinusBatch: interactive.repaired - batch.repaired,
    mechanismGatePassed:
      arms.every((a) => a.errors === 0) &&
      interactive.repaired >= batch.repaired + 3 &&
      interactive.cases.every((c, i) => c.repaired >= batch.cases[i].repaired),
    limitation:
      "Four consumed development cases, three stochastic repetitions per arm. Equal native action opportunity, unequal model calls and cost. Privileged researcher repairs, not ordinary agent execution or cross-user learning. No fresh/recipient evaluation or model-weight training.",
  };
}
