import { validateToolArguments } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import "../test-helpers/fast-coding-tools.js";
import { createBitterbotCodingTools } from "../agent-tools.js";
import { toToolDefinitions } from "../runtime/engines/pi/tool-definition-adapter.js";
import { toPlainJsonSchema } from "./plain-json-schema.js";
import { stringEnum } from "./typebox.js";

type AjvCtor = new (opts: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const Ajv = ((AjvModule as unknown as { default?: AjvCtor }).default ??
  AjvModule) as unknown as AjvCtor;

// Every @sinclair/typebox construct our tool schemas use (see `Type.*` in src/agents/tools).
const coverageSchema = Type.Object({
  n: Type.Optional(Type.Number()),
  i: Type.Optional(Type.Integer()),
  b: Type.Optional(Type.Boolean()),
  s: Type.Optional(Type.String()),
  e: Type.Optional(stringEnum(["a", "b"] as const)),
  arr: Type.Optional(Type.Array(Type.Number())),
  u: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  lit: Type.Optional(Type.Literal("x")),
  rec: Type.Optional(Type.Record(Type.String(), Type.Number())),
  nested: Type.Optional(Type.Object({ k: Type.Number() })),
  unk: Type.Optional(Type.Unknown()),
  req: Type.String(),
});

const cases: Array<Record<string, unknown>> = [
  { n: "5" },
  { i: "7" },
  { i: "7.5" },
  { b: "true" },
  { b: "1" },
  { s: 5 },
  { s: true },
  { e: "a" },
  { e: "z" },
  { arr: ["1", 2] },
  { arr: "5" },
  { u: 3 },
  { u: true },
  { lit: "x" },
  { lit: "y" },
  { nested: { k: "3" } },
  { n: null },
  { n: "abc" },
  { unk: { a: 1 } },
  { extra: 1 },
  {},
];

function runPi(parameters: unknown, args: Record<string, unknown>): string {
  try {
    const out = validateToolArguments(
      { name: "t", description: "", parameters } as never,
      { type: "toolCall", id: "1", name: "t", arguments: args } as never,
    ) as unknown;
    return JSON.stringify(out);
  } catch (err) {
    expect(String(err)).toContain("Validation failed");
    return "REJECTED";
  }
}

describe("toPlainJsonSchema", () => {
  const reference = new Ajv({ allErrors: true, strict: false, coerceTypes: true }).compile(
    JSON.parse(JSON.stringify(coverageSchema)),
  );

  it("drops the TypeBox symbols but keeps the serialized schema identical", () => {
    const plain = toPlainJsonSchema(coverageSchema);
    expect(JSON.stringify(plain)).toBe(JSON.stringify(coverageSchema));
    expect(Object.getOwnPropertySymbols(coverageSchema).length).toBeGreaterThan(0);
    expect(Object.getOwnPropertySymbols(plain)).toEqual([]);
    expect(toPlainJsonSchema(coverageSchema)).toBe(plain);
  });

  it("matches pi-ai 0.52.12's Ajv (coerceTypes) behaviour under pi-ai's current validator", () => {
    const plain = toPlainJsonSchema(coverageSchema);
    for (const args of cases) {
      const withReq = { req: "r", ...args };
      const copy = structuredClone(withReq);
      const expected = reference(copy) ? JSON.stringify(copy) : "REJECTED";
      expect(runPi(plain, withReq), JSON.stringify(args)).toBe(expected);
    }
  });

  it("documents the one known gap: no coercion inside Type.Record values", () => {
    const plain = toPlainJsonSchema(coverageSchema);
    const args = { req: "r", rec: { a: "1" } };
    const copy = structuredClone(args);
    expect(reference(copy)).toBe(true);
    expect(copy.rec.a).toBe(1);
    expect(runPi(plain, args)).toBe("REJECTED");
  });

  it("without it, pi-ai's current validator stops coercing 0.34 schemas", () => {
    expect(runPi(coverageSchema, { req: "r", n: "5" })).toBe("REJECTED");
    expect(runPi(toPlainJsonSchema(coverageSchema), { req: "r", n: "5" })).toBe(
      JSON.stringify({ req: "r", n: 5 }),
    );
  });
});

describe("agent tool schemas under pi-ai's validator", () => {
  it("every registered tool definition compiles and validates", () => {
    const tools = createBitterbotCodingTools({
      workspaceDir: "/tmp",
      config: {},
      sessionKey: "agent:main:main",
      agentSessionKey: "agent:main:main",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-8",
      modelAuthMode: "api-key",
    } as never);
    // Native tool search exposes the full registry, not just the hot set.
    expect(tools.length).toBeGreaterThan(40);
    for (const definition of toToolDefinitions(tools)) {
      expect(Object.getOwnPropertySymbols(definition.parameters), definition.name).toEqual([]);
      // Either passes or is rejected with a validation error: never a schema compile failure.
      runPi(definition.parameters, {});
    }
  });
});
