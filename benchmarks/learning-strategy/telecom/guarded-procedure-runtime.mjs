import assert from "node:assert/strict";
import { validateDiagnosticActions } from "./diagnostic-actions.mjs";
import { runDiagnosticSession } from "./diagnostic-session.mjs";
import { forbidden } from "./feedback.mjs";
import { runRepairAttempt } from "./interactive-repair2-runtime.mjs";
import { publicTrace, parseResponse } from "./rediscovery2-engineer.mjs";

const VARIABLES = ["customerId", "lineId", "phoneNumber"];
const keys = (v, expected) => assert.deepEqual(Object.keys(v).sort(), [...expected].sort());

// Identity binding uses public account lookup results, never the private scenario or grading state.
// Refuse ambiguous histories instead of choosing the first customer's account or line.
export function bindPublicIdentity(episode) {
  const lookups = episode.transcript.filter(
    (t) =>
      t.type === "tool" && t.seat === "actor" && t.name === "get_customer_by_phone" && !t.error,
  );
  assert.ok(lookups.length, "No public customer lookup");
  const pairs = lookups.map((t) => ({
    phoneNumber: t.arguments.phone_number,
    customerId: JSON.parse(t.content).customer_id,
  }));
  assert.equal(new Set(pairs.map((p) => JSON.stringify(p))).size, 1, "Ambiguous customer lookup");
  const binding = pairs[0];
  assert.ok(Object.values(binding).every((v) => typeof v === "string" && v.length > 0));
  const lines = episode.transcript
    .filter(
      (t) => t.type === "tool" && t.seat === "actor" && t.name === "get_details_by_id" && !t.error,
    )
    .map((t) => JSON.parse(t.content))
    .filter((v) => v.line_id && v.phone_number === binding.phoneNumber);
  assert.equal(new Set(lines.map((l) => l.line_id)).size, 1, "Missing or ambiguous affected line");
  const customers = lookups.map((t) => JSON.parse(t.content));
  assert.ok(
    customers.every((c) => Array.isArray(c.line_ids) && c.line_ids.includes(lines[0].line_id)),
    "Line is not linked to customer",
  );
  return { ...binding, lineId: lines[0].line_id };
}

export function resolveArguments(text, bindings) {
  const parsed = JSON.parse(text);
  const walk = (v) => {
    if (typeof v === "string" && v.startsWith("${")) {
      assert.ok(/^\$\{(customerId|lineId|phoneNumber)\}$/.test(v), "Unknown or partial variable");
      const name = v.slice(2, -1);
      assert.equal(typeof bindings[name], "string");
      return bindings[name];
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          assert.ok(!["__proto__", "constructor", "prototype"].includes(k));
          return [k, walk(x)];
        }),
      );
    return v;
  };
  const args = walk(parsed);
  assert.ok(args && typeof args === "object" && !Array.isArray(args));
  return args;
}

const predicateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["step", "format", "path", "valueJson"],
  properties: {
    step: { type: "string" },
    format: { type: "string", enum: ["json", "line", "text"] },
    path: { type: "string" },
    valueJson: { type: "string" },
  },
};
export function procedureSchema(context) {
  const step = {
    type: "object",
    additionalProperties: false,
    required: ["id", "tool", "argumentsJson", "when", "successWhen"],
    properties: {
      id: { type: "string" },
      tool: { type: "string", enum: context.tools.map((t) => t.tool) },
      argumentsJson: { type: "string" },
      when: { type: "array", items: predicateSchema },
      successWhen: { type: "array", items: predicateSchema },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["assessment", "procedure"],
    properties: {
      assessment: { type: "string" },
      procedure: {
        type: "object",
        additionalProperties: false,
        required: ["description", "steps"],
        properties: { description: { type: "string" }, steps: { type: "array", items: step } },
      },
    },
  };
}

export function validateProcedure(procedure, context) {
  keys(procedure, ["description", "steps"]);
  assert.ok(
    typeof procedure.description === "string" &&
      procedure.description.length > 0 &&
      procedure.description.length <= 1000,
  );
  assert.ok(
    JSON.stringify(procedure).length <= 10000 && !forbidden.test(JSON.stringify(procedure)),
    "Oversized program or instance identity",
  );
  assert.ok(
    Array.isArray(procedure.steps) && procedure.steps.length >= 2 && procedure.steps.length <= 6,
    "Expected 2..6 steps",
  );
  const known = new Map(),
    native = { agentTools: [], userTools: [] };
  for (const t of context.tools)
    native[t.role === "assistant" ? "agentTools" : "userTools"].push({
      function: { name: t.name, parameters: t.parameters },
    });
  for (const step of procedure.steps) {
    keys(step, ["id", "tool", "argumentsJson", "when", "successWhen"]);
    assert.match(step.id, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.ok(!known.has(step.id), "Duplicate step");
    const tool = context.tools.find((t) => t.tool === step.tool);
    assert.ok(tool, "Unknown tool");
    const template = JSON.parse(step.argumentsJson),
      args = resolveArguments(
        step.argumentsJson,
        Object.fromEntries(VARIABLES.map((v) => [v, `bound-${v}`])),
      );
    for (const [key, variable] of [
      ["customer_id", "customerId"],
      ["line_id", "lineId"],
      ["phone_number", "phoneNumber"],
    ])
      if (Object.hasOwn(template, key))
        assert.equal(template[key], `\${${variable}}`, "Entity arguments must use bindings");
    if (Object.hasOwn(template, "id"))
      assert.ok(
        ["${customerId}", "${lineId}"].includes(template.id),
        "ID must use a public binding",
      );
    const checked = validateDiagnosticActions(
      [{ tool: step.tool, argumentsJson: JSON.stringify(args) }],
      native,
    );
    assert.ok(checked.valid, JSON.stringify(checked.errors));
    assert.ok(["READ", "WRITE"].includes(tool.effect));
    for (const [name, predicates] of [
      ["when", step.when],
      ["successWhen", step.successWhen],
    ]) {
      assert.ok(Array.isArray(predicates) && predicates.length <= 3);
      for (const pred of predicates) {
        keys(pred, ["step", "format", "path", "valueJson"]);
        const source =
          known.get(pred.step) ?? (name === "successWhen" && pred.step === step.id ? tool : null);
        assert.equal(
          source?.effect,
          "READ",
          "Conditions must reference a current earlier read; success may reference this read",
        );
        assert.ok(["json", "line", "text"].includes(pred.format));
        assert.equal(typeof pred.path, "string");
        assert.ok(pred.path.length <= 120);
        if (pred.format === "json") assert.match(pred.path, /^(\/(?:[^~/]|~[01])*)*$/);
        if (pred.format === "line") assert.ok(pred.path.length > 0 && !pred.path.includes("\n"));
        if (pred.format === "text") assert.equal(pred.path, "");
        const value = JSON.parse(pred.valueJson);
        assert.ok(value === null || ["string", "number", "boolean"].includes(typeof value));
        assert.ok(pred.valueJson.length <= 300);
      }
    }
    if (tool.effect === "WRITE")
      assert.ok(
        step.when.length > 0 && step.successWhen.length === 0,
        "Every mutation needs a current read guard and cannot claim success",
      );
    known.set(step.id, tool);
  }
  const first = procedure.steps[0],
    last = procedure.steps.at(-1);
  assert.equal(known.get(first.id).effect, "READ");
  assert.equal(first.tool, last.tool, "Start and finish with the same outcome check");
  assert.equal(first.argumentsJson, last.argumentsJson);
  assert.equal(first.when.length, 0);
  assert.equal(last.when.length, 0);
  assert.ok(first.successWhen.length > 0 && last.successWhen.length > 0);
  assert.ok(
    first.successWhen.every((p) => p.step === first.id) &&
      last.successWhen.every((p) => p.step === last.id),
  );
  const normalize = (ps) => ps.map((p) => ({ ...p, step: "outcome" }));
  assert.deepEqual(normalize(first.successWhen), normalize(last.successWhen));
  return procedure;
}

export function evaluatePredicate(predicate, observations) {
  const response = observations[predicate.step];
  if (!response || response.error) return "unknown";
  const expected = JSON.parse(predicate.valueJson);
  let value;
  if (predicate.format === "text") value = response.content;
  else if (predicate.format === "line") {
    const values = response.content
      .split(/\r?\n/)
      .filter((l) => l.startsWith(predicate.path + ":"))
      .map((l) => l.slice(predicate.path.length + 1).trim());
    if (values.length !== 1) return "unknown";
    value = values[0];
  } else {
    try {
      value = JSON.parse(response.content);
      for (const encoded of predicate.path.split("/").slice(1)) {
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        if (
          !value ||
          typeof value !== "object" ||
          !Object.hasOwn(value, key) ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          return "unknown";
        value = value[key];
      }
    } catch {
      return "unknown";
    }
  }
  return value === expected;
}
function conjunction(predicates, observations) {
  const values = predicates.map((p) => evaluatePredicate(p, observations));
  return values.includes("unknown") ? "unknown" : values.every(Boolean);
}

export function createProcedureSelector(procedure, bindings) {
  const state = { status: "running", selfVerified: false, observations: {}, log: [] };
  let cursor = 0,
    pending;
  const ingest = (events) => {
    if (!pending) return;
    const event = events.filter((e) => e.type === "action")[pending.ordinal];
    if (event?.status !== "returned") return;
    const step = pending.step;
    pending = null;
    state.observations[step.id] = structuredClone(event.response);
    state.log.push({
      step: step.id,
      status: "returned",
      response: structuredClone(event.response),
    });
    if (event.response.error) {
      state.status = "tool-error";
      return;
    }
    if (step.successWhen.length) {
      const outcome = conjunction(step.successWhen, state.observations);
      if (outcome === "unknown") state.status = "unknown-outcome";
      if (outcome === true) {
        state.selfVerified = true;
        state.status = "verified";
      }
    }
  };
  return {
    state,
    select: async (view) => {
      ingest(view.events);
      if (state.status !== "running") return null;
      while (cursor < procedure.steps.length) {
        const step = procedure.steps[cursor++],
          guard = conjunction(step.when, state.observations);
        state.log.push({ step: step.id, status: "guard", value: guard });
        if (guard === "unknown") {
          state.status = "unknown-guard";
          return null;
        }
        if (!guard) continue;
        pending = { step, ordinal: view.events.filter((e) => e.type === "action").length };
        return {
          tool: step.tool,
          argumentsJson: JSON.stringify(resolveArguments(step.argumentsJson, bindings)),
        };
      }
      state.status = "unverified";
      return null;
    },
    finish: (events) => {
      ingest(events);
      if (state.status === "running") state.status = pending ? "interrupted" : "unverified";
      return structuredClone(state);
    },
  };
}

export function procedureRequest(context, evidence, feedback = null) {
  return {
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          task: "Derive a reusable conditional repair procedure from the supplied verified repair and omission evidence. The previous model discovered the repairs; the host has not supplied a recipe. Preserve applicability, identify the affected entity, inspect current state before mutation, avoid changing already-working inputs, and verify the requested service. Separate demonstrated necessity on exact inputs from broader hypotheses. This is privileged synthetic diagnostic execution, not a normal customer conversation.",
          contract:
            "Return assessment and procedure {description,steps}. Each of 2..6 steps: id(lowercase identifier), tool(role-qualified), argumentsJson(JSON object), when(array of predicates), successWhen(array of predicates). Predicate: step(previous read id; successWhen may use this read), format(json|line|text), path(JSON pointer for json, exact field before colon for line, empty for text), valueJson(JSON-encoded scalar). Predicates are exact equality, ANDed; empty when means always. Missing/ambiguous/error observations stop execution. A false guard skips its step. A true nonempty successWhen stops successfully. Every WRITE must have an earlier READ guard. First and last steps must use the same READ tool/arguments with identical own-result success predicates and empty when, to preserve already-working states and verify the final outcome. Arguments use exact string placeholders ${customerId},${lineId},${phoneNumber}; customer_id,line_id,phone_number must use their corresponding placeholder and id must use customerId or lineId. Those bindings are derived from unique, linked public lookup records, never hidden state. No concrete identities or executable code. Maxdescription1000chars,totalJSON10000chars,eachpredicatevalue300chars. Tool READ/WRITE classifications are native metadata. No new runtime variables, retries, arbitrary conditions or loops. Same procedure will be given as advice to an LLM and executed by the interpreter. You have at most one compiler-only correction, with no new task feedback.",
          policy: context.policy,
          tools: context.tools,
          evidence,
          compilerFeedback: feedback,
        }),
      },
    ],
    output_config: { format: { type: "json_schema", schema: procedureSchema(context) } },
    cache_control: { type: "ephemeral" },
  };
}

export async function generateProcedure(provider, label, context, evidence) {
  const calls = [];
  let feedback = null,
    procedure = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await provider.call(procedureRequest(context, evidence, feedback), {
      tag: `${label}:procedure-${attempt}`,
      maxTokens: 4096,
    });
    calls.push(response);
    try {
      const parsed = parseResponse(response);
      keys(parsed, ["assessment", "procedure"]);
      assert.equal(typeof parsed.assessment, "string");
      procedure = validateProcedure(parsed.procedure, context);
      return { valid: true, procedure, assessment: parsed.assessment, calls, feedback };
    } catch (error) {
      feedback = {
        error: error.message,
        previousSubmission: response.content,
        kind: "compiler-only",
        taskFeedback: null,
      };
    }
  }
  return { valid: false, procedure: null, calls, feedback };
}

export async function runGuardedAttempt({
  assignment,
  source,
  artifact,
  evidence,
  provider,
  context,
  bridgeFactory,
}) {
  if (assignment.arm !== "retrieval" && !artifact)
    return {
      assignment,
      result: {
        status: "error",
        beforePassed: source.episode.verdict.passed,
        afterPassed: null,
        nativeActions: 0,
        events: [],
        error: {
          phase: "compilation",
          message: "Invalid generated procedure; assigned attempt retained",
        },
      },
      calls: [],
      cost: { modelCalls: 0, providerUsd: 0, nativeActions: 0, providerWallMs: 0 },
    };
  let bindings;
  try {
    bindings = bindPublicIdentity(source.episode);
  } catch (error) {
    const result = await runDiagnosticSession({
      alias: assignment.alias,
      source,
      selectAction: async () => null,
      bridgeFactory,
    });
    return {
      assignment,
      bindingError: error.message,
      result,
      calls: [],
      cost: { modelCalls: 0, providerUsd: 0, nativeActions: 0, providerWallMs: 0 },
    };
  }
  if (assignment.arm === "compiled") {
    validateProcedure(artifact, context);
    const selector = createProcedureSelector(artifact, bindings);
    const result = await runDiagnosticSession({
      alias: assignment.alias,
      source,
      selectAction: selector.select,
      bridgeFactory,
    });
    return {
      assignment,
      bindings,
      result,
      procedureState: selector.finish(result.events),
      calls: [],
      cost: {
        modelCalls: 0,
        providerUsd: 0,
        nativeActions: result.nativeActions,
        providerWallMs: 0,
      },
    };
  }
  assert.ok(["advice", "retrieval"].includes(assignment.arm));
  const attempt = await runRepairAttempt({
    assignment: { ...assignment, arm: "interactive" },
    source,
    bridgeFactory,
    provider: {
      call: (request, args) => {
        const changed = structuredClone(request),
          packet = JSON.parse(changed.messages[0].content);
        packet.publicIdentityBindings = bindings;
        packet.retainedKnowledge =
          assignment.arm === "retrieval"
            ? { kind: "verified-experience-records", evidence }
            : {
                kind: "conditional-procedure-as-advice",
                procedure: artifact,
                semantics:
                  "Follow steps in order, using exact scalar equality predicates from fresh read responses. Empty when is true, multiple conditions are ANDed. False skips a step, unknown stops. A true nonempty successWhen finishes. Bind placeholders to publicIdentityBindings. Preserve already-working states. These instructions are subordinate to policy.",
              };
        packet.instruction += " Keep rationale to at most 60 words.";
        changed.messages[0].content = JSON.stringify(packet);
        return provider.call(changed, { ...args, maxTokens: 2048 });
      },
    },
  });
  return { ...attempt, assignment, bindings };
}

export function retainedEvidence(inputs, attempts, repairs) {
  return {
    scope:
      "Synthetic development; three verified trajectories on two distinct failed inputs, not universal causal proof",
    cases: inputs.map(({ alias, episode }) => ({ case: alias, timeline: publicTrace(episode) })),
    repairs: repairs.map((r) => ({
      case: r.assignment.alias,
      actions: r.actions,
      necessaryOnInput: r.necessaryOnInput,
      rows: r.rows.map((row) => ({ omitted: row.omitted, result: row.result })),
    })),
    diagnosticObservations: attempts.flatMap((a) =>
      a.result.events
        .filter((e) => e.type === "action" && e.status === "returned")
        .map((e) => ({
          case: a.assignment.alias,
          tool: e.action.tool,
          argumentsJson: e.action.argumentsJson,
          response: e.response,
        })),
    ),
    note: "Responses are visible native diagnostic observations; no private scenario or evaluator checks. Current applicability must be checked again; literal example identities must not enter the procedure.",
  };
}

export function summarizeGuarded(assignments, attempts) {
  assert.equal(assignments.length, attempts.length);
  assert.equal(new Set(attempts.map((a) => a.assignment.label)).size, assignments.length);
  for (const assignment of assignments)
    assert.deepEqual(
      attempts.find((a) => a.assignment.label === assignment.label)?.assignment,
      assignment,
    );
  const groups = [...new Set(assignments.map((a) => `${a.arm}:${a.candidate ?? "shared"}`))];
  return groups.map((group) => {
    const rows = attempts.filter(
      (a) => `${a.assignment.arm}:${a.assignment.candidate ?? "shared"}` === group,
    );
    return {
      group,
      assigned: rows.length,
      repaired: rows.filter((a) => a.result.afterPassed === true).length,
      errors: rows.filter((a) => a.result.status === "error").length,
      selfVerified: rows.filter((a) => a.procedureState?.selfVerified === true).length,
      modelCalls: rows.reduce((s, a) => s + a.cost.modelCalls, 0),
      nativeActions: rows.reduce((s, a) => s + a.cost.nativeActions, 0),
      providerUsd: rows.reduce((s, a) => s + a.cost.providerUsd, 0),
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
}

export function panelSummary(assignments, attempts, context) {
  summarizeGuarded(assignments, attempts);
  return [...new Set(assignments.map((a) => a.candidate))].map((candidate) => {
    const rows = attempts.filter((a) => a.assignment.candidate === candidate),
      failed = rows.filter((a) => a.result.beforePassed === false),
      healthy = rows.filter((a) => a.result.beforePassed === true);
    const writes = (a) =>
      a.result.events.filter(
        (e) =>
          e.type === "action" &&
          context.tools.find((t) => t.tool === e.action.tool)?.effect === "WRITE",
      ).length;
    return {
      candidate,
      assigned: rows.length,
      failed: failed.length,
      repaired: failed.filter((a) => a.result.afterPassed === true).length,
      healthy: healthy.length,
      preserved: healthy.filter((a) => a.result.afterPassed === true).length,
      healthyWrites: healthy.reduce((s, a) => s + writes(a), 0),
      abstained: rows.filter((a) => a.bindingError).length,
      errors: rows.filter((a) => a.result.status === "error").length,
      selfVerifiedFalsePositives: rows.filter(
        (a) => a.procedureState?.selfVerified && a.result.afterPassed !== true,
      ).length,
    };
  });
}

export function qualificationGate(artifacts, primary, panel) {
  return (
    artifacts.every((a) => a.valid) &&
    primary.every((r) => r.errors === 0) &&
    artifacts.every((a) => {
      const compiled = primary.find((r) => r.group === `compiled:${a.candidate}`),
        advice = primary.find((r) => r.group === `advice:${a.candidate}`),
        more = panel.find((r) => r.candidate === a.candidate);
      return (
        compiled.repaired >= 10 &&
        compiled.repaired >= advice.repaired &&
        more.repaired >= Math.ceil(more.failed / 2) &&
        more.preserved === more.healthy &&
        more.healthyWrites === 0 &&
        more.errors === 0 &&
        more.selfVerifiedFalsePositives === 0
      );
    })
  );
}
