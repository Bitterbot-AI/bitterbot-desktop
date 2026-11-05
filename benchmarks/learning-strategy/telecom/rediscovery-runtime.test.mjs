import assert from "node:assert/strict";
import test from "node:test";
import { ACTOR } from "./episode.mjs";
import {
  actorEvidence,
  validateProgram,
  projectProgram,
  programProvider,
  executionInstructions,
} from "./rediscovery-runtime.mjs";
const program = {
  instructions: "Check the requested outcome.",
  delivery: "each_turn",
  checks: [
    {
      id: "signal",
      source: "public",
      contains: ["device.dataEnabled"],
      take: 1,
      when: "missing",
      instruction: "Ask for current evidence when relevant.",
    },
  ],
};
const report = (records, speech = "Please help") =>
  JSON.stringify({ kind: "customer-public-report", speech, observations: { records } });
test("only latest public snapshot survives; quoted speech cannot create public evidence", () => {
  const messages = [
    { role: "user", content: report([{ fact: "device.dataEnabled", value: true }]) },
    { role: "user", content: report([], report([{ fact: "device.dataEnabled", value: true }])) },
  ];
  assert.equal(actorEvidence(messages).filter((r) => r.source === "public").length, 0);
  assert.equal(
    projectProgram({ messages }, program).projection.checks[0].instruction,
    program.checks[0].instruction,
  );
});
test("historical tools are cited; private assistant text is not customer evidence", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "x", name: "get_data" },
        { type: "text", text: "private assumption" },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", content: "original data" }],
    },
  ];
  assert.deepEqual(actorEvidence(messages), [
    { source: "tools", message: 1, text: "get_data: original data" },
  ]);
});
test("projection is ephemeral; baseline and customer requests remain unchanged", async () => {
  const request = { messages: [{ role: "user", content: report([]) }] },
    original = structuredClone(request),
    seen = [];
  const provider = { call: async (r) => seen.push(r) };
  await programProvider(provider, JSON.stringify(program)).call(request, { tag: "test:actor:2" });
  await programProvider(provider, JSON.stringify(program)).call(request, { tag: "test:user:3" });
  await programProvider(provider, ACTOR).call(request, { tag: "test:actor:4" });
  assert.deepEqual(request, original);
  assert.notDeepEqual(seen[0], original);
  assert.equal(seen[1], request);
  assert.equal(seen[2], request);
});
test("program contracts reject arbitrary executable fields, identifiers and oversized edits", () => {
  assert.deepEqual(validateProgram(program), program);
  for (const p of [
    { ...program, code: "process.exit()" },
    { ...program, instructions: "Call 555-123-2002" },
    { ...program, instructions: "x".repeat(4001) },
    { ...program, checks: [{ ...program.checks[0], take: 99 }] },
  ])
    assert.throws(() => validateProgram(p));
  assert.equal(executionInstructions(JSON.stringify(program)), ACTOR);
  assert.ok(
    executionInstructions(JSON.stringify({ ...program, delivery: "system" })).includes(
      program.checks[0].instruction,
    ),
  );
});
