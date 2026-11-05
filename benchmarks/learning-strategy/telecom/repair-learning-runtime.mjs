import assert from "node:assert/strict";
import { COMMON, verifyRepairSequence as verifyOriginal } from "./interactive-repair-runtime.mjs";
import { runRepairAttempt as runOriginal } from "./interactive-repair2-runtime.mjs";
import { publicTrace, generateProgram } from "./rediscovery2-engineer.mjs";

export const CONDITIONS = ["blind", "experience"];
export function learningEvidence(sources, attempts) {
  return {
    summaries: attempts.map((a) => ({
      case: a.assignment.alias,
      condition: a.assignment.arm,
      repetition: a.assignment.repetition,
      passed: a.result.afterPassed,
      status: a.result.status,
      nativeActions: a.result.nativeActions,
      modelCalls: a.calls.length,
    })),
    cases: sources.map(({ alias, episode }) => {
      const attempt = attempts.find(
        (a) =>
          a.assignment.alias === alias &&
          a.assignment.arm === "interactive" &&
          a.assignment.repetition === 0,
      );
      assert.ok(attempt);
      return {
        case: alias,
        initialPassed: episode.verdict.passed,
        traceTruncated: false,
        timeline: publicTrace(episode),
        firstInteractiveAttempt: { plans: attempt.plans, result: attempt.result },
      };
    }),
    selection:
      "All attempt summaries; complete original public trace and first interactive attempt per case, selected by repetition number regardless of outcome. No private scenario or criterion-level grade. Null outcomes are unverified, not evidence of a particular cause.",
  };
}

export function controllerPacket(condition, context, evidence) {
  assert.ok(CONDITIONS.includes(condition));
  return {
    task: "Engineer a reusable investigation strategy for a diagnostic agent trying to repair an already failed customer-support state. Return a system-delivered advisory program that improves how it investigates. Infer useful changes yourself; no human diagnosis or repair recipe is supplied. Preserve native policy, tool contracts and unrelated state. Do not claim unobserved success. Your program must not contain case/customer identifiers or literal instance values. You cannot change the evaluator, action budget, provider or permissions.",
    baseController: COMMON,
    capabilities:
      "The diagnostic researcher sees the original complete public trace, current policy and role-qualified tools, then chooses one native action after each complete prior result. Six native actions, eight decisions including rejections. Final binary grade only after the session. The researcher may operate account and device tools in an isolated synthetic copy; normal agents still require consent and role separation. Both evaluated conditions use 2048 output tokens per decision and are asked for rationale <=60 words. Output program delivery system, instructions1..3500characters, total compact program<=4000characters; one compiler-only revision after an invalid submission. No execution feedback during candidate generation or the new evaluation.",
    policy: context.policy,
    tools: context.tools,
    evidence:
      condition === "experience"
        ? evidence
        : "Execution histories, grades, probe outcomes and human diagnosis withheld. Improve the controller using only its instructions, policy and tool contracts. The same generation and compiler-revision opportunity is available.",
  };
}

export function generateController(provider, condition, context, evidence) {
  return generateProgram(
    provider,
    controllerPacket(condition, context, evidence),
    { delivery: "system" },
    [],
    {
      label: `repair-controller-${condition}`,
      remainingUsd: 20,
    },
  );
}

export async function runControllerAttempt({ assignment, controller, ...options }) {
  assert.ok(CONDITIONS.includes(assignment.arm));
  const provider = options.provider;
  const attempt = await runOriginal({
    ...options,
    assignment: { ...assignment, arm: "interactive" },
    provider: {
      call: (request, args) => {
        const transformed = structuredClone(request);
        transformed.system +=
          "\n\nGenerated investigation strategy (subordinate to policy):\n" + controller;
        const packet = JSON.parse(transformed.messages[0].content);
        packet.instruction +=
          " Keep your rationale to at most 60 words. Spend the response on a concrete next action, not a long essay.";
        transformed.messages[0].content = JSON.stringify(packet);
        return provider.call(transformed, { ...args, maxTokens: 2048 });
      },
    },
  });
  return { ...attempt, assignment, controller };
}

export function verifyControllerSequence(options) {
  return verifyOriginal(options);
}

export function summarizeLearning(assignments, attempts) {
  assert.equal(attempts.length, assignments.length);
  assert.equal(new Set(attempts.map((a) => a.assignment.label)).size, assignments.length);
  for (const assignment of assignments)
    assert.deepEqual(
      attempts.find((a) => a.assignment.label === assignment.label)?.assignment,
      assignment,
    );
  const arms = CONDITIONS.map((arm) => {
    const rows = attempts.filter((a) => a.assignment.arm === arm);
    return {
      arm,
      assigned: rows.length,
      repaired: rows.filter((a) => a.result.afterPassed === true).length,
      errors: rows.filter((a) => a.result.status === "error").length,
      modelCalls: rows.reduce((s, a) => s + a.cost.modelCalls, 0),
      nativeActions: rows.reduce((s, a) => s + a.cost.nativeActions, 0),
      evaluationUsd: rows.reduce((s, a) => s + a.cost.providerUsd, 0),
      cases: [...new Set(rows.map((a) => a.assignment.index))]
        .sort((a, b) => a - b)
        .map((index) => ({
          index,
          assigned: rows.filter((a) => a.assignment.index === index).length,
          repaired: rows.filter(
            (a) => a.assignment.index === index && a.result.afterPassed === true,
          ).length,
        })),
    };
  });
  const [blind, experience] = arms;
  return {
    arms,
    experienceMinusBlind: experience.repaired - blind.repaired,
    gatePassed:
      arms.every((a) => a.errors === 0) &&
      experience.repaired >= blind.repaired + 3 &&
      experience.cases.every((c, i) => c.repaired >= blind.cases[i].repaired),
    limitation:
      "Development-only comparison on four consumed source states, three stochastic repetitions. One independently generated controller per condition. Same repaired interface and model/action budget. No ordinary-agent benefit, cross-user transfer, fresh-case evidence, or model-weight learning.",
  };
}
