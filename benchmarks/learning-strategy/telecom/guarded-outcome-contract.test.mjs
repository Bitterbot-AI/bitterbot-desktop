import assert from "node:assert/strict";
import test from "node:test";
import { validateOutcomeProcedure, outcomeProcedureRequest } from "./guarded-outcome-contract.mjs";
const context = {
  policy: "fixture",
  tools: ["service", "setting"].map((name) => ({
    tool: `user.${name}`,
    name,
    role: "user",
    effect: "READ",
    parameters: { type: "object", required: [] },
  })),
};
const predicate = (step) => ({ step, format: "text", path: "", valueJson: '"working"' });
const procedure = () => ({
  description: "Generic outcome-contract fixture",
  steps: [
    {
      id: "initial",
      tool: "user.service",
      argumentsJson: "{}",
      when: [],
      successWhen: [predicate("initial")],
    },
    { id: "inspect", tool: "user.setting", argumentsJson: "{}", when: [], successWhen: [] },
    {
      id: "final",
      tool: "user.service",
      argumentsJson: "{}",
      when: [],
      successWhen: [predicate("final")],
    },
  ],
});
test("an intermediate prerequisite cannot terminate a procedure as successful", () => {
  const p = procedure();
  p.steps[1].successWhen = [predicate("inspect")];
  assert.throws(() => validateOutcomeProcedure(p, context), /Only the initial and final/);
});
test("initial and final declared outcome checks remain supported", () => {
  assert.equal(validateOutcomeProcedure(procedure(), context).steps.length, 3);
});
test("prospective generator sees the same stronger compiler contract", () => {
  const r = outcomeProcedureRequest(context, { records: [] });
  assert.match(
    JSON.parse(r.messages[0].content).contract,
    /Intermediate steps must have empty successWhen/,
  );
});
