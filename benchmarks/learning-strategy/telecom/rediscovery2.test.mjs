import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createBridge } from "./bridge.mjs";
import { ACTOR } from "./episode.mjs";
import { explicitPurchasePreference } from "./rediscovery2-customer-contract.mjs";
import {
  publicTrace,
  feedbackSummary,
  engineerPacket,
  generateProgram,
} from "./rediscovery2-engineer.mjs";
import { actorContext } from "./rediscovery2-episode.mjs";
import {
  validateProgram,
  executionInstructions,
  programProvider,
} from "./rediscovery2-runtime.mjs";

test("customer amendment preserves native tools, actor context and source object", async () => {
  const b = createBridge();
  try {
    const original = await b.request({ method: "reset", index: 39 }),
      before = structuredClone(original),
      updated = explicitPurchasePreference(original);
    assert.deepEqual(original, before);
    assert.deepEqual(actorContext(updated, ACTOR), actorContext(original, ACTOR));
    assert.deepEqual(updated.userTools, original.userTools);
    assert.match(updated.userScenario.instructions.task_instructions, /exactly 2.0 GB/);
    assert.throws(() =>
      explicitPurchasePreference({
        userScenario: { instructions: { task_instructions: "willing to refuel 3GB" } },
      }),
    );
  } finally {
    b.close();
  }
});
test("static delivery rejects ignored conditional fields and preserves baseline", async () => {
  const p = { delivery: "system", instructions: "If a prerequisite is unknown, investigate it." };
  assert.deepEqual(validateProgram(p), p);
  assert.throws(() => validateProgram({ ...p, checks: [] }));
  assert.ok(executionInstructions(JSON.stringify(p)).startsWith(ACTOR));
  let received;
  const request = { messages: [{ role: "user", content: "unchanged" }] },
    options = { tag: "case-0:actor:1" };
  await programProvider(
    {
      call: async (r) => {
        received = r;
      },
    },
    ACTOR,
  ).call(request, options);
  assert.equal(received, request);
});
test("trace joins actor actions/results while excluding private/rejected customer data", () => {
  const episode = {
    publicConversation: [{ seat: "user", text: "Thanks" }],
    transcript: [
      {
        seat: "user",
        id: "private",
        content: [
          { type: "text", text: "PRIVATE_REASONING" },
          { type: "tool_use", id: "u", name: "check_network_status", input: {} },
        ],
      },
      { type: "tool", seat: "user", content: "PRIVATE_DEVICE_VALUE" },
      {
        seat: "actor",
        id: "a",
        content: [
          { type: "tool_use", id: "call-1", name: "get_details_by_id", input: { id: "L1002" } },
        ],
      },
      {
        type: "tool",
        seat: "actor",
        name: "get_details_by_id",
        arguments: { id: "L1002" },
        content: '{"plan_id":"P1001","roaming_enabled":false}',
        error: false,
      },
      {
        type: "public-observations",
        speech: "The device shows no data",
        snapshot: { records: [{ fact: "data", value: false }] },
      },
      {
        seat: "user",
        id: "end",
        content: [
          { type: "text", text: "Thanks" },
          { type: "tool_use", name: "end_conversation", input: {} },
        ],
      },
    ],
  };
  const trace = publicTrace(episode),
    serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes("PRIVATE_"));
  assert.equal(trace[1].callId, "call-1");
  assert.equal(trace[1].arguments.id, "L1002");
  assert.ok(trace[1].content.includes("P1001"));
  assert.equal(trace.at(-1).speech, "Thanks");
});
test("complete evidence fits without truncation; blind branch cannot read the episode bank", () => {
  const root = "benchmarks/learning-strategy/results/telecom-rediscovery-discovery-v2";
  const history = JSON.parse(fs.readFileSync(root + "/initial-history.json", "utf8")),
    context = JSON.parse(fs.readFileSync(root + "/engineer-context.json", "utf8"));
  const args = {
    round: 0,
    actor: ACTOR,
    context,
    feedback: history.map((r) => JSON.stringify(feedbackSummary(r.episode, r.case))),
  };
  const p = engineerPacket({
    ...args,
    branch: "experience",
    bank: new Map(history.map((r) => [r.case, r])),
  });
  assert.equal(p.evidence.traces.length, 3);
  assert.equal(p.evidence.omitted.length, 0);
  for (const row of p.evidence.traces) {
    assert.equal(row.traceTruncated, false);
    assert.deepEqual(row.timeline, publicTrace(history.find((r) => r.case === row.case).episode));
  }
  const blind = engineerPacket({
    ...args,
    branch: "blind",
    bank: {
      get() {
        throw Error("Secret bank accessed");
      },
    },
  });
  assert.equal(typeof blind.evidence, "string");
  assert.ok(!JSON.stringify(blind).includes(history[0].episode.publicConversation[0].text));
});
test("one compiler repair preserves rejection, charges both calls and stops after success", async () => {
  const invalid = {
    assessment: "No execution evidence",
    program: { delivery: "system", instructions: "Use evidence.", checks: [] },
  };
  const valid = {
    assessment: "Compiler correction only",
    program: { delivery: "system", instructions: "Use observed evidence." },
  };
  const requests = [];
  const provider = {
    call: async (request, options) => {
      requests.push({ request, options });
      return {
        id: String(requests.length),
        usd: 0.1,
        stopReason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(requests.length === 1 ? invalid : valid) }],
      };
    },
  };
  const result = await generateProgram(
    provider,
    { evidence: "withheld" },
    { delivery: "system" },
    [{ status: "withheld-control" }],
    { label: "blind-r0", remainingUsd: 8 },
  );
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].generated.valid, false);
  assert.equal(result.generated.valid, true);
  assert.equal(result.usd, 0.2);
  assert.ok(requests[1].request.messages[0].content.includes("own-submission-compiler-feedback"));
  assert.ok(requests[1].request.messages[0].content.includes('\\"checks\\":[]'));
  assert.equal(requests[1].options.localRemaining, 7.9);
});
test("repeated compiler failures stop at the fixed two-attempt limit", async () => {
  let calls = 0;
  const result = await generateProgram(
    {
      call: async () => ({
        id: String(++calls),
        usd: 0.1,
        stopReason: "max_tokens",
        content: [{ type: "text", text: "{}" }],
      }),
    },
    {},
    { delivery: "system" },
    [],
    { label: "x", remainingUsd: 8 },
  );
  assert.equal(calls, 2);
  assert.equal(result.generated.valid, false);
});
