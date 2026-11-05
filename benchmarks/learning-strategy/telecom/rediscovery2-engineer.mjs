import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ENGINEER,
  DIAGNOSIS_SCHEMA as BASE_SCHEMA,
  diagnosisRequest as baseDiagnosisRequest,
  parseResponse,
  diagnosticProbes,
} from "./rediscovery-engineer.mjs";
import { SCHEMAS, parseProgram, compilerFeedback } from "./rediscovery2-runtime.mjs";
export { ENGINEER, parseResponse, diagnosticProbes };
export const CAPABILITIES =
  "Choose delivery in your diagnostic plan. For system delivery, return ONLY delivery and instructions (1..3500 characters); no checks/search metadata exists. It appends the instruction text once. For each_turn delivery, use instructions <=2000 characters plus up to 6 checks; each check has unique lowercase id <=40, source customer/tools/public, contains 1..4 literal search strings of 1..80 characters, take integer1..3, when always/found/missing, instruction1..500 characters. Total compact program JSON <=4000 characters. each_turn reads only actor-visible historical customer speech/tool responses and the latest explicit public snapshot. Matches do not establish current truth. The baseline and policy remain authoritative. Generated content may not contain instance identities, account IDs or phone numbers. You may revise a compiler-rejected submission once, using only mechanical feedback. There are no human repairs. Static instructions must express conditional advice as prose, not assert facts about a case.";
const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Private synthetic development evidence; never a real-user anonymizer. */
export function publicTrace(episode) {
  const rows = [],
    pending = [];
  const rejected = new Set(
    episode.transcript
      .filter((r) => ["grounding", "observation-failure"].includes(r.type))
      .map((r) => r.responseId),
  );
  for (const r of episode.transcript) {
    if (r.type === "public-observations")
      rows.push({ kind: "customer-publication", speech: r.speech, snapshot: r.snapshot });
    else if (r.type === "tool" && r.seat === "actor") {
      const call = pending.shift();
      assert.ok(call);
      assert.equal(call.name, r.name);
      assert.deepEqual(call.input, r.arguments);
      rows.push({
        kind: "actor-tool-result",
        callId: call.id,
        name: r.name,
        arguments: r.arguments,
        content: r.content,
        error: r.error,
      });
    } else if (r.id && r.seat === "actor") {
      rows.push({ kind: "actor-response", content: r.content });
      pending.push(...r.content.filter((b) => b.type === "tool_use"));
    } else if (
      r.id &&
      r.seat === "user" &&
      !rejected.has(r.id) &&
      r.content.some((b) => b.type === "tool_use" && b.name === "end_conversation")
    ) {
      const speech = r.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (speech && episode.publicConversation.some((t) => t.seat === "user" && t.text === speech))
        rows.push({ kind: "customer-final-speech", speech });
    }
  }
  return rows;
}
export function feedbackSummary(episode, caseId) {
  return {
    case: caseId,
    passed: episode.verdict.passed && ["user-ended", "human-transfer"].includes(episode.reason),
    termination: episode.reason,
    traceHash: digest(publicTrace(episode)),
  };
}
export function engineerPacket({
  branch,
  round,
  actor,
  feedback,
  context,
  bank,
  previousCompilerFeedback = null,
}) {
  const summaries = branch === "experience" ? feedback.map(JSON.parse) : [];
  const packet = {
    engineer: ENGINEER,
    capabilities: CAPABILITIES,
    round,
    parentProgram: actor,
    previousCompilerFeedback,
    policy: context.policy,
    agentTools: context.agentTools,
    customerTools: context.userTools,
    evidence:
      branch === "experience"
        ? {
            summaries,
            traces: [],
            omitted: [],
            note: "Complete selected actor-visible traces, retaining arguments, results and identifier associations. Synthetic data only; keep instance values out of generated programs. No private customer tools or hidden scenario. Missing traces are identified, never interpreted as absent actions.",
          }
        : "Execution histories, grades, diagnostic results and host selection are withheld. Reason from policy/tools and your own prior submission. Return no probes. Mechanical compiler feedback and the same maximum revision opportunity are available to both arms.",
    diagnosticContract:
      "Experience only: up to 3 native experiments, at most 6 actions each, on isolated copies of parent final states. Use case aliases from summaries and tool names/arguments from the provided contracts. Roles assistant or user are privileged development capabilities; normal support execution retains role separation and consent. Results include before/after binary outcome and tool outputs, not hidden assertions. Terminal handoff is unavailable. Failed probes are retained without retries. Explicitly assess which hypotheses are supported, refuted or unresolved before writing your program.",
  };
  if (branch === "experience") {
    const selected = [
      ...summaries.filter((r) => !r.passed).slice(0, 2),
      ...summaries.filter((r) => r.passed).slice(0, 1),
    ];
    for (const s of selected) {
      const e = bank.get(s.case)?.episode;
      assert.ok(e);
      assert.deepEqual(feedbackSummary(e, s.case), s);
      const row = { ...s, traceTruncated: false, timeline: publicTrace(e) };
      packet.evidence.traces.push(row);
      if (Buffer.byteLength(JSON.stringify(packet)) > 180000) {
        packet.evidence.traces.pop();
        packet.evidence.omitted.push({
          case: s.case,
          reason: "complete trace exceeds request allocation; no middle sections removed",
        });
      }
    }
    if (summaries.some((r) => !r.passed))
      assert.ok(
        packet.evidence.traces.some((r) => !r.passed),
        "No complete failed trace fits; qualify a different evidence interface",
      );
  }
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= 185000);
  return packet;
}
export function diagnosisRequest(packet) {
  const request = baseDiagnosisRequest(packet);
  request.output_config.format.schema = {
    ...BASE_SCHEMA,
    required: [...BASE_SCHEMA.required, "delivery"],
    properties: {
      ...BASE_SCHEMA.properties,
      delivery: { type: "string", enum: ["system", "each_turn"] },
    },
  };
  return request;
}
export function programRequest(packet, diagnosis, probes, repair = null) {
  const request = {
    messages: [
      {
        role: "user",
        content:
          JSON.stringify({
            ...packet,
            diagnosis,
            diagnosticResults: probes,
            compilerRepair: repair,
          }) +
          "\nReturn assessment and program. In assessment, distinguish supported, refuted and unresolved hypotheses using actual probe outputs (or explain evidence is withheld). Do not invent results. Produce a reusable program with the chosen delivery. A rejected first submission gets at most one compiler-only revision; no human fixes or task feedback between those attempts.",
      },
    ],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["assessment", "program"],
          properties: { assessment: { type: "string" }, program: SCHEMAS[diagnosis.delivery] },
        },
      },
    },
    cache_control: { type: "ephemeral" },
  };
  assert.ok(SCHEMAS[diagnosis.delivery]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(request)) < 299000,
    "Generation request exceeds qualified allocation",
  );
  return request;
}

export async function generateProgram(
  provider,
  packet,
  diagnosis,
  probes,
  { label, remainingUsd, signal },
) {
  const attempts = [];
  let usd = 0,
    response,
    generated,
    feedback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await provider.call(programRequest(packet, diagnosis, probes, feedback), {
      tag: `${label}:program-${attempt}`,
      maxTokens: 4096,
      localRemaining: remainingUsd - usd,
      signal,
    });
    usd += response.usd;
    generated = parseProgram(response, diagnosis.delivery);
    attempts.push({ id: response.id, generated });
    feedback = compilerFeedback(response, diagnosis.delivery);
    if (generated.valid) break;
  }
  return { attempts, response, generated, feedback, usd };
}
