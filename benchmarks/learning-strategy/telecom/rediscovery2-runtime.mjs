import assert from "node:assert/strict";
import { ACTOR } from "./episode.mjs";
import { forbidden } from "./feedback.mjs";
import { programDiagnostics } from "./rediscovery-compile-feedback.mjs";
import {
  PROGRAM_SCHEMA,
  validateProgram as validateRetrieval,
  projectProgram,
} from "./rediscovery-runtime.mjs";

export const SCHEMAS = {
  system: {
    type: "object",
    additionalProperties: false,
    required: ["delivery", "instructions"],
    properties: {
      delivery: { type: "string", enum: ["system"] },
      instructions: { type: "string" },
    },
  },
  each_turn: {
    ...PROGRAM_SCHEMA,
    properties: { ...PROGRAM_SCHEMA.properties, delivery: { type: "string", enum: ["each_turn"] } },
  },
};
export function validateProgram(p, delivery = p?.delivery) {
  assert.equal(p?.delivery, delivery, "Program delivery must match the diagnostic plan");
  if (delivery === "each_turn") return validateRetrieval(p);
  assert.equal(delivery, "system");
  assert.deepEqual(Object.keys(p).sort(), ["delivery", "instructions"]);
  assert.ok(
    typeof p.instructions === "string" &&
      p.instructions.length > 0 &&
      p.instructions.length <= 3500,
    "System instructions must contain 1..3500 characters",
  );
  assert.ok(JSON.stringify(p).length <= 4000, "Compact program must fit 4000 characters");
  assert.ok(!forbidden.test(JSON.stringify(p)), "Instance identifier in generated program");
  return p;
}
export function parseProgram(response, delivery) {
  try {
    assert.notEqual(response.stopReason, "max_tokens", "Generation was truncated");
    const result = JSON.parse(
      response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    );
    assert.deepEqual(Object.keys(result).sort(), ["assessment", "program"]);
    assert.equal(typeof result.assessment, "string");
    const program = validateProgram(result.program, delivery);
    return { valid: true, program, actor: JSON.stringify(program), assessment: result.assessment };
  } catch (error) {
    let details = [];
    try {
      const result = JSON.parse(
        response.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
      );
      if (delivery === "each_turn") details = programDiagnostics(result.program).errors;
    } catch {
      /* The primary diagnostic already describes malformed JSON. */
    }
    return { valid: false, error: error.message, details };
  }
}
export function compilerFeedback(response, delivery) {
  if (!response) return null;
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = parseProgram(response, delivery);
  return {
    kind: "own-submission-compiler-feedback",
    previousSubmission: text.slice(0, 16000),
    truncated: text.length > 16000,
    valid: parsed.valid,
    ...(parsed.valid ? {} : { error: parsed.error, details: parsed.details }),
    note: "Mechanical compiler results only. No task scores or host selection. Revise your own submission; the host has not edited it.",
  };
}
export function executionInstructions(actor) {
  if (actor === ACTOR) return ACTOR;
  const p = validateProgram(JSON.parse(actor));
  return p.delivery === "system"
    ? ACTOR + "\n\nGenerated procedure (subordinate to policy):\n" + p.instructions
    : ACTOR;
}
export function programProvider(provider, actor, onProjection = () => {}) {
  const p = actor === ACTOR ? null : validateProgram(JSON.parse(actor));
  return {
    call: async (request, options) => {
      if (!p || p.delivery !== "each_turn" || options.tag.split(":").at(-2) !== "actor")
        return provider.call(request, options);
      const projected = projectProgram(request, p);
      onProjection({ tag: options.tag, projection: projected.projection });
      return provider.call(projected.request, options);
    },
  };
}
