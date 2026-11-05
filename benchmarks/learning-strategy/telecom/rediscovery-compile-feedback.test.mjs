import assert from "node:assert/strict";
import test from "node:test";
import {
  compilerFeedback,
  programDiagnostics,
  withCompilerFeedback,
} from "./rediscovery-compile-feedback.mjs";
import { validateProgram } from "./rediscovery-runtime.mjs";

const program = () => ({
  instructions: "Use observed evidence and respect the customer's choices.",
  delivery: "system",
  checks: [
    {
      id: "verify",
      source: "public",
      contains: ["result"],
      take: 1,
      when: "found",
      instruction: "Verify the result.",
    },
  ],
});
const response = (p) => ({
  content: [{ type: "text", text: JSON.stringify(p) }],
  stop_reason: "end_turn",
});

test("reports all observed mechanical failure classes without repairing the proposal", () => {
  const p = program();
  p.checks[0].contains = ["a", "b", "c", "d", "e"];
  p.checks[0].instruction = "x".repeat(501);
  p.instructions = "x".repeat(3900);
  const before = structuredClone(p),
    result = compilerFeedback(response(p));
  assert.equal(result.valid, false);
  for (const path of ["$.checks[0].contains", "$.checks[0].instruction", "$.instructions", "$"])
    assert.ok(result.errors.some((e) => e.path === path));
  assert.deepEqual(JSON.parse(result.previousSubmission), before);
  assert.deepEqual(p, before);
  assert.throws(() => validateProgram(p));
});

test("acceptance remains controlled by the unchanged interpreter", () => {
  const p = program();
  assert.deepEqual(programDiagnostics(p), { valid: true, errors: [] });
  p.instructions = "Call customer 555-123-4567";
  assert.throws(() => validateProgram(p));
  assert.equal(programDiagnostics(p).valid, false);
  for (const invalid of [null, 4, [], {}, { ...program(), checks: [null] }])
    assert.equal(programDiagnostics(invalid).valid, false);
});

test("truncated generation cannot compile even when its text parses", () => {
  const r = response(program());
  r.stop_reason = "max_tokens";
  assert.equal(compilerFeedback(r).valid, false);
  assert.equal(compilerFeedback({ content: [{ type: "text", text: "{" }] }).valid, false);
  assert.equal(compilerFeedback(null), null);
});

test("same mechanical feedback attaches to either arm without supplying grades or mutating packets", () => {
  const r = response(program()),
    blind = { evidence: "withheld", parentProgram: "old" };
  const experience = { evidence: { summaries: [{ passed: false }] }, parentProgram: "old" };
  const b = withCompilerFeedback(blind, r),
    e = withCompilerFeedback(experience, r);
  assert.deepEqual(b.compilerFeedback, e.compilerFeedback);
  assert.equal(b.evidence, "withheld");
  assert.equal(Object.hasOwn(blind, "compilerFeedback"), false);
  assert.equal(JSON.stringify(b).includes('"passed"'), false);
  assert.deepEqual(r, response(program()));
});

test("oversized submission feedback is explicitly bounded and never accepted", () => {
  const p = program();
  p.instructions = "x".repeat(18000);
  const result = compilerFeedback(response(p));
  assert.equal(result.valid, false);
  assert.equal(result.previousSubmission.length, 16000);
  assert.equal(result.submissionTruncated, true);
});
