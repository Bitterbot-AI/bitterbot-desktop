import assert from "node:assert/strict";
import { validateProcedure, procedureRequest } from "./guarded-procedure-runtime.mjs";

// Prospective hardening discovered during guarded-procedure-v1. The frozen study does not
// import this module. It restricts success to the declared outcome; it cannot prove that
// the model chose the right outcome tool, which still requires independent evaluation.
export function validateOutcomeProcedure(procedure, context) {
  validateProcedure(procedure, context);
  for (const step of procedure.steps.slice(1, -1))
    assert.equal(
      step.successWhen.length,
      0,
      "Only the initial and final declared outcome checks may report success; intermediate prerequisites cannot establish task completion",
    );
  return procedure;
}

export function outcomeProcedureRequest(context, evidence, feedback = null) {
  const request = procedureRequest(context, evidence, feedback),
    packet = JSON.parse(request.messages[0].content);
  packet.contract +=
    " Intermediate steps must have empty successWhen. Only the initial and final declared service outcome checks can establish success; a prerequisite being satisfied is not evidence that the requested task works. Failure of the final outcome check means unresolved, never success.";
  request.messages[0].content = JSON.stringify(packet);
  return request;
}
