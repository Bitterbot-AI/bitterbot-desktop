import { validateToolArguments } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import { coerceExecEnvOverrides, execSchema } from "./bash-tools.exec-runtime.js";
import { toPlainJsonSchema } from "./schema/plain-json-schema.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * The schema the model and the validator actually see is the normalized
 * (Gemini-cleaned) one, which drops the `env` value schema, so numbers and
 * booleans pass validation and used to reach `validateHostEnv` / the sandbox
 * env builder / the node host untyped. exec now converts them to strings.
 */
describe("exec env overrides", () => {
  const execTool = { name: "exec", parameters: execSchema } as unknown as AnyAgentTool;
  const validateWith = (parameters: unknown, args: Record<string, unknown>) =>
    validateToolArguments({ name: "exec", parameters: toPlainJsonSchema(parameters) } as never, {
      type: "toolCall",
      id: "t",
      name: "exec",
      arguments: args,
    });

  it("the normalized schema (what the loop validates against) admits number and boolean values", () => {
    const normalized = normalizeToolParameters(execTool).parameters;
    expect(() =>
      validateWith(normalized, { command: "env", env: { PORT: 3000, DEBUG: true, HOME: "/tmp" } }),
    ).not.toThrow();
  });

  it("the raw schema admits them too, without a union keyword", () => {
    expect(JSON.stringify(execSchema)).not.toMatch(/anyOf|oneOf/);
    expect(() =>
      validateWith(execSchema, { command: "env", env: { PORT: 3000, DEBUG: true } }),
    ).not.toThrow();
    expect(() => validateWith(execSchema, { command: "env", env: { X: { nested: 1 } } })).toThrow();
    expect(() => validateWith(execSchema, { command: "env", env: { X: null } })).toThrow();
  });

  it("coerceExecEnvOverrides stringifies every value and leaves undefined alone", () => {
    expect(coerceExecEnvOverrides({ PORT: 3000, DEBUG: true, OFF: false, HOME: "/tmp" })).toEqual({
      PORT: "3000",
      DEBUG: "true",
      OFF: "false",
      HOME: "/tmp",
    });
    expect(coerceExecEnvOverrides(undefined)).toBeUndefined();
  });
});
