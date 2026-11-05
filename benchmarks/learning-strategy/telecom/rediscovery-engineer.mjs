import assert from "node:assert/strict";
import { createBridge } from "./bridge.mjs";
import { projectFeedback } from "./feedback.mjs";
import { PROGRAM_SCHEMA, validateProgram } from "./rediscovery-runtime.mjs";

export const ENGINEER =
  "Engineer reusable improvements to a customer-support agent. Investigate causes, distinguish interface failures from actor failures, preserve successful behavior, and verify hypotheses with available development experiments. You may design a bounded advisory program, but cannot change policy, tools, the simulator or the evaluator. Do not include case identifiers or customer-specific values in the program. No particular diagnosis or solution is supplied.";
export const CAPABILITIES =
  "A program has instructions (at most 2000 characters), delivery system or each_turn, and up to 6 checks. Total compact JSON must be <=4000 characters. Each check: unique lowercase id <=40; source customer, tools, or public; contains 1-4 literal search strings <=80 characters; take 1-3 recent matches; when always, found or missing; instruction <=500 characters. At each_turn, the host searches actor-visible customer speech, historical actor tool responses, or only the latest explicit public fact snapshot. Matching is case-insensitive literal OR. It supplies cited excerpts (up to 1200 characters each) and emits instructions according to when. Matches do not prove truth or current state. Original history remains available. With system delivery, instructions and all check instructions are placed once in the system context, without retrieval or conditions. The original baseline instructions and policy always remain. This is a declarative program, not executable source. Design any useful approach in this space; do not assume repeating advice is best.";
export const DIAGNOSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheses", "probes"],
  properties: {
    hypotheses: { type: "string" },
    probes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["case", "actions"],
        properties: {
          case: { type: "string" },
          actions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["role", "name", "argumentsJson"],
              properties: {
                role: { type: "string", enum: ["assistant", "user"] },
                name: { type: "string" },
                argumentsJson: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
export function parseResponse(response) {
  assert.notEqual(response.stopReason, "max_tokens", "Engineer output truncated");
  return JSON.parse(
    response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  );
}
export function feedbackRow(episode, caseId) {
  const projected = projectFeedback(episode);
  const text = JSON.stringify(
    projected.timeline.map((r) => {
      if (!r.observations) return r;
      const { observations, ...rest } = r;
      return {
        ...rest,
        publicSnapshot: Object.fromEntries(observations.records.map((v) => [v.fact, v.value])),
      };
    }),
  );
  const bindings = [
    ...new Set(
      episode.transcript
        .filter((r) => r.type === "tool" && r.seat === "actor")
        .flatMap((r) =>
          Object.values(r.arguments ?? {}).filter(
            (v) => typeof v === "string" && /^(?:555-|[CLPBD]\d{4})/.test(v),
          ),
        ),
    ),
  ];
  return {
    case: caseId,
    passed: episode.verdict.passed && ["user-ended", "human-transfer"].includes(episode.reason),
    termination: projected.termination,
    actorObservedSyntheticBindings: bindings,
    traceTruncated: text.length > 6000,
    publicTrace:
      text.length <= 6000
        ? text
        : text.slice(0, 1500) + "\n[Middle omitted; absence is not evidence]\n" + text.slice(-4500),
  };
}
export function engineerPacket({ branch, round, actor, feedback, context }) {
  const rows = branch === "experience" ? feedback.map(JSON.parse) : [];
  const selected = [
    ...rows.filter((r) => !r.passed).slice(0, 2),
    ...rows.filter((r) => r.passed).slice(0, 1),
  ];
  return {
    engineer: ENGINEER,
    capabilities: CAPABILITIES,
    round,
    parentProgram: actor,
    policy: context.policy,
    agentTools: context.agentTools,
    customerTools: context.userTools,
    evidence:
      branch === "experience"
        ? {
            summaries: rows.map(
              ({ publicTrace: _trace, actorObservedSyntheticBindings: _bindings, ...r }) => r,
            ),
            traces: selected,
          }
        : "Execution history, grades, selection outcomes and diagnostic results are withheld in this feedback-ablation control. Use the policy, tool contracts and your previous design. Return no probes. Your proposals receive the same fixed number of evaluations and the same final host selection rule.",
    diagnosticContract:
      "Experience branch only: propose up to 3 experiments, each at most 6 native actions, using case aliases from the summaries. Each experiment resets a copy to that parent trial's final state, applies your chosen actions, and reports before/after binary native success plus tool outputs. Roles may be assistant or user. These are privileged development probes, not actions available to the deployed support agent; consent and role separation still apply during evaluated conversations. No initialization, private customer scenario, hidden task specification or reference solution is exposed. Known synthetic IDs observed by the actor are provided for tool arguments. Terminal handoff and unsupported tools are unavailable. Invalid probes return errors and are not retried.",
  };
}
export function diagnosisRequest(packet) {
  return {
    messages: [
      {
        role: "user",
        content:
          JSON.stringify(packet) +
          "\nForm competing explanations and choose informative diagnostic experiments. Return hypotheses and probes.",
      },
    ],
    output_config: { format: { type: "json_schema", schema: DIAGNOSIS_SCHEMA } },
    cache_control: { type: "ephemeral" },
  };
}
export function programRequest(packet, diagnosis, probes) {
  return {
    messages: [
      {
        role: "user",
        content:
          JSON.stringify({ ...packet, diagnosis, diagnosticResults: probes }) +
          "\nEngineer one reusable program using the supplied contract. Use evidence where available, preserve successful behavior and account for uncertainty. Return only the program JSON. This is your final submission for this round; no manual repair or extra generation is available.",
      },
    ],
    output_config: { format: { type: "json_schema", schema: PROGRAM_SCHEMA } },
    cache_control: { type: "ephemeral" },
  };
}
export async function diagnosticProbes(diagnosis, branch, bank) {
  if (branch !== "experience") return [{ status: "withheld-control" }];
  if (!Array.isArray(diagnosis?.probes) || diagnosis.probes.length > 3)
    return [{ error: "At most three probes are allowed" }];
  const results = [];
  for (const p of diagnosis.probes) {
    const b = createBridge();
    const actions = [];
    try {
      const source = bank.get(p.case);
      assert.ok(source, "Unknown case alias");
      assert.ok(
        Array.isArray(p.actions) && p.actions.length >= 1 && p.actions.length <= 6,
        "Probe needs 1-6 actions",
      );
      const context = await b.request({ method: "reset", index: source.index });
      for (const t of source.episode.transcript.filter((r) => r.type === "tool")) {
        const r = await b.request({
          method: "call",
          role: t.seat === "actor" ? "assistant" : "user",
          name: t.name,
          arguments: t.arguments,
        });
        assert.equal(r.content, t.content);
        assert.equal(r.error, t.error);
      }
      const before = await b.request({ method: "judge" });
      assert.equal(before.passed, source.episode.verdict.passed);
      for (const a of p.actions) {
        assert.ok(["assistant", "user"].includes(a.role), "Unsupported role");
        const tools = a.role === "assistant" ? context.agentTools : context.userTools;
        assert.ok(
          a.name !== "transfer_to_human_agents" && tools.some((t) => t.function.name === a.name),
          "Unsupported diagnostic tool",
        );
        const args = JSON.parse(a.argumentsJson);
        const result = await b.request({
          method: "call",
          role: a.role,
          name: a.name,
          arguments: args,
        });
        actions.push({
          ...a,
          ...result,
          content: result.content.slice(0, 1500),
          truncated: result.content.length > 1500,
        });
      }
      const after = await b.request({ method: "judge" });
      results.push({
        case: p.case,
        beforePassed: before.passed,
        afterPassed: after.passed,
        actions,
      });
    } catch (error) {
      results.push({ case: p.case, actions, error: error.message });
    } finally {
      b.close();
    }
  }
  return results;
}
export function parseProgram(response) {
  try {
    const program = validateProgram(parseResponse(response));
    return { valid: true, program, actor: JSON.stringify(program) };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}
