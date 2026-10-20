/**
 * models.json schema and validation.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono):
 * the schema block and `formatValidationPath` of `src/core/model-registry.ts`.
 * The validator is a port of the part of typebox 1.3.34 (MIT, sinclairzx81)
 * that pi's schema reaches: `schema/engine` error generation for the keywords
 * `type`, `required`, `patternProperties`, `properties`, `items`,
 * `minLength`, `const` and `anyOf`, and the `en_US` messages for them.
 *
 * Why a port and not a library: pi validates with `typebox` 1.x, which is not
 * a direct dependency of this repo (the repo has `@sinclair/typebox` 0.34 and
 * `ajv`, both of which produce different error lists and message texts).
 * `ModelRegistry.getError()` embeds those messages, so the small piece is
 * ported to keep the error strings identical.
 *
 * What is ported: the JSON Schema that pi's `Type.*` calls produce (same
 * keywords, same property order), typebox's evaluation order per schema node
 * (type, then object keywords, array keywords, string keywords, const,
 * anyOf), exhaustive (non short-circuit) error collection, the limit of 8
 * errors per error context (anyOf operands each get a fresh context), JSON
 * Pointer escaping of path fragments, and optional properties accepting
 * `undefined`.
 *
 * Differences from the original:
 * - Static types are written by hand instead of derived with `Static<>`.
 * - There is one code path. typebox has a compiled `Check` and an interpreted
 *   `Errors`; here a value is valid when the error list is empty.
 * - typebox's locale can be swapped at runtime; the messages here are fixed
 *   to `en_US`, the default pi runs with.
 * - String length is counted in code points directly (typebox has a fast path
 *   that gives the same answer).
 *
 * Not ported: every typebox keyword pi's schema does not use, unevaluated
 * property tracking, refs, codecs, and schema compilation.
 *
 * pi quirk kept: `compat` is a union of three object schemas whose properties
 * are all optional, so any object passes (a wrong-typed field in one member
 * is accepted by another member). Only a non-object `compat` is rejected.
 */

import type { Api, Model } from "@mariozechner/pi-ai";

// ----------------------------------------------------------------------------
// JSON Schema subset and builders (mirror typebox's output for pi's Type calls)
// ----------------------------------------------------------------------------

type JsonSchema = {
  type?: "object" | "array" | "boolean" | "number" | "null" | "string";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minLength?: number;
  const?: string;
  anyOf?: JsonSchema[];
};

type Field = JsonSchema | { optional: JsonSchema };

function isOptionalField(field: Field): field is { optional: JsonSchema } {
  return "optional" in field;
}

const optional = (schema: JsonSchema): Field => ({ optional: schema });
const string = (options?: { minLength: number }): JsonSchema => ({ type: "string", ...options });
const number = (): JsonSchema => ({ type: "number" });
const boolean = (): JsonSchema => ({ type: "boolean" });
const nullType = (): JsonSchema => ({ type: "null" });
const literal = (value: string): JsonSchema => ({ type: "string", const: value });
const union = (members: JsonSchema[]): JsonSchema => ({ anyOf: members });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const record = (value: JsonSchema): JsonSchema => ({
  type: "object",
  patternProperties: { "^.*$": value },
});

function object(fields: Record<string, Field>): JsonSchema {
  const required: string[] = [];
  const properties: Record<string, JsonSchema> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (isOptionalField(field)) {
      properties[key] = field.optional;
    } else {
      required.push(key);
      properties[key] = field;
    }
  }
  return required.length > 0
    ? { type: "object", required, properties }
    : { type: "object", properties };
}

// ----------------------------------------------------------------------------
// Schema (same shape and order as pi's)
// ----------------------------------------------------------------------------

// OpenRouter routing preferences.
const PercentileCutoffsSchema = object({
  p50: optional(number()),
  p75: optional(number()),
  p90: optional(number()),
  p99: optional(number()),
});

const OpenRouterRoutingSchema = object({
  allow_fallbacks: optional(boolean()),
  require_parameters: optional(boolean()),
  data_collection: optional(union([literal("deny"), literal("allow")])),
  zdr: optional(boolean()),
  enforce_distillable_text: optional(boolean()),
  order: optional(array(string())),
  only: optional(array(string())),
  ignore: optional(array(string())),
  quantizations: optional(array(string())),
  sort: optional(
    union([
      string(),
      object({
        by: optional(string()),
        partition: optional(union([string(), nullType()])),
      }),
    ]),
  ),
  max_price: optional(
    object({
      prompt: optional(union([number(), string()])),
      completion: optional(union([number(), string()])),
      image: optional(union([number(), string()])),
      audio: optional(union([number(), string()])),
      request: optional(union([number(), string()])),
    }),
  ),
  preferred_min_throughput: optional(union([number(), PercentileCutoffsSchema])),
  preferred_max_latency: optional(union([number(), PercentileCutoffsSchema])),
});

// Vercel AI Gateway routing preferences.
const VercelGatewayRoutingSchema = object({
  only: optional(array(string())),
  order: optional(array(string())),
});

// Thinking level support and provider-specific values.
const ThinkingLevelMapValueSchema = union([string(), nullType()]);
const ThinkingLevelMapSchema = object({
  off: optional(ThinkingLevelMapValueSchema),
  minimal: optional(ThinkingLevelMapValueSchema),
  low: optional(ThinkingLevelMapValueSchema),
  medium: optional(ThinkingLevelMapValueSchema),
  high: optional(ThinkingLevelMapValueSchema),
  xhigh: optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = object({
  supportsStore: optional(boolean()),
  supportsDeveloperRole: optional(boolean()),
  supportsReasoningEffort: optional(boolean()),
  supportsUsageInStreaming: optional(boolean()),
  maxTokensField: optional(union([literal("max_completion_tokens"), literal("max_tokens")])),
  requiresToolResultName: optional(boolean()),
  requiresAssistantAfterToolResult: optional(boolean()),
  requiresThinkingAsText: optional(boolean()),
  requiresReasoningContentOnAssistantMessages: optional(boolean()),
  thinkingFormat: optional(
    union([
      literal("openai"),
      literal("openrouter"),
      literal("deepseek"),
      literal("zai"),
      literal("qwen"),
      literal("qwen-chat-template"),
    ]),
  ),
  cacheControlFormat: optional(literal("anthropic")),
  openRouterRouting: optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: optional(VercelGatewayRoutingSchema),
  supportsStrictMode: optional(boolean()),
  supportsLongCacheRetention: optional(boolean()),
});

const OpenAIResponsesCompatSchema = object({
  sendSessionIdHeader: optional(boolean()),
  supportsLongCacheRetention: optional(boolean()),
});

const AnthropicMessagesCompatSchema = object({
  supportsEagerToolInputStreaming: optional(boolean()),
  supportsLongCacheRetention: optional(boolean()),
});

const ProviderCompatSchema = union([
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
  AnthropicMessagesCompatSchema,
]);

// Custom model definition. Most fields are optional with defaults that suit
// local models (Ollama, LM Studio, etc.).
const ModelDefinitionSchema = object({
  id: string({ minLength: 1 }),
  name: optional(string({ minLength: 1 })),
  api: optional(string({ minLength: 1 })),
  baseUrl: optional(string({ minLength: 1 })),
  reasoning: optional(boolean()),
  thinkingLevelMap: optional(ThinkingLevelMapSchema),
  input: optional(array(union([literal("text"), literal("image")]))),
  cost: optional(
    object({
      input: number(),
      output: number(),
      cacheRead: number(),
      cacheWrite: number(),
    }),
  ),
  contextWindow: optional(number()),
  maxTokens: optional(number()),
  headers: optional(record(string())),
  compat: optional(ProviderCompatSchema),
});

// Per-model overrides (all fields optional, merged with the built-in model).
const ModelOverrideSchema = object({
  name: optional(string({ minLength: 1 })),
  reasoning: optional(boolean()),
  thinkingLevelMap: optional(ThinkingLevelMapSchema),
  input: optional(array(union([literal("text"), literal("image")]))),
  cost: optional(
    object({
      input: optional(number()),
      output: optional(number()),
      cacheRead: optional(number()),
      cacheWrite: optional(number()),
    }),
  ),
  contextWindow: optional(number()),
  maxTokens: optional(number()),
  headers: optional(record(string())),
  compat: optional(ProviderCompatSchema),
});

const ProviderConfigSchema = object({
  name: optional(string({ minLength: 1 })),
  baseUrl: optional(string({ minLength: 1 })),
  apiKey: optional(string({ minLength: 1 })),
  api: optional(string({ minLength: 1 })),
  headers: optional(record(string())),
  compat: optional(ProviderCompatSchema),
  authHeader: optional(boolean()),
  models: optional(array(ModelDefinitionSchema)),
  modelOverrides: optional(record(ModelOverrideSchema)),
});

/** Exported for tests only. */
export const ModelsConfigSchema: JsonSchema = object({
  providers: record(ProviderConfigSchema),
});

// ----------------------------------------------------------------------------
// Static types (pi derives these from the schema)
// ----------------------------------------------------------------------------

type ThinkingLevelMapConfig = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

type ProviderCompatConfig = NonNullable<Model<Api>["compat"]>;

export type ModelDefinition = {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMapConfig;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ProviderCompatConfig;
};

export type ModelOverride = {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMapConfig;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: ProviderCompatConfig;
};

export type ProviderConfig = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: ProviderCompatConfig;
  authHeader?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, ModelOverride>;
};

export type ModelsConfig = {
  providers: Record<string, ProviderConfig>;
};

// ----------------------------------------------------------------------------
// Validator (typebox 1.3.34 error generation, restricted to the keywords above)
// ----------------------------------------------------------------------------

type ValidationError = {
  keyword: "type" | "required" | "minLength" | "const" | "anyOf";
  instancePath: string;
  /** `type`: the expected type name. `minLength`: the limit. */
  detail?: string | number;
  /** `required`: every missing property, in schema order. */
  requiredProperties?: string[];
};

/** typebox `Settings.maxErrors` default. */
const MAX_ERRORS = 8;

class ErrorContext {
  readonly errors: ValidationError[] = [];

  atCapacity(): boolean {
    return this.errors.length >= MAX_ERRORS;
  }

  /** Always returns false so a failed check reads `check || context.add(...)`. */
  add(error: ValidationError): false {
    if (!this.atCapacity()) {
      this.errors.push(error);
    }
    return false;
  }
}

function isObjectNotArray(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkType(type: NonNullable<JsonSchema["type"]>, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObjectNotArray(value);
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return Number.isFinite(value);
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
  }
}

/** JSON Pointer escaping of one path fragment. */
function encodeFragment(fragment: string): string {
  return fragment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function hasPropertyKey(value: Record<string, unknown>, key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype"
    ? Object.prototype.hasOwnProperty.call(value, key)
    : key in value;
}

function codePointCount(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

/**
 * Collect errors for `value` against `schema`. Every check runs (no short
 * circuit), in typebox's order. Returns whether the value is valid.
 */
function errorSchema(
  context: ErrorContext,
  instancePath: string,
  schema: JsonSchema,
  value: unknown,
): boolean {
  // A context that is full cannot record anything more; typebox stops here.
  if (context.atCapacity()) {
    return false;
  }
  let valid = true;

  if (schema.type !== undefined && !checkType(schema.type, value)) {
    valid = context.add({ keyword: "type", instancePath, detail: schema.type });
  }

  if (isObjectNotArray(value)) {
    if (schema.required) {
      const requiredProperties = schema.required.filter((key) => !hasPropertyKey(value, key));
      if (requiredProperties.length > 0) {
        valid = context.add({ keyword: "required", instancePath, requiredProperties });
      }
    }
    if (schema.patternProperties) {
      for (const [pattern, propertySchema] of Object.entries(schema.patternProperties)) {
        const regexp = new RegExp(pattern, "u");
        for (const [key, propertyValue] of Object.entries(value)) {
          if (!regexp.test(key)) {
            continue;
          }
          const nextPath = `${instancePath}/${encodeFragment(key)}`;
          if (!errorSchema(context, nextPath, propertySchema, propertyValue)) {
            valid = false;
          }
        }
      }
    }
    if (schema.properties) {
      const required = schema.required ?? [];
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        // An optional property may be present with the value undefined.
        if (!required.includes(key) && value[key] === undefined) {
          continue;
        }
        if (!hasPropertyKey(value, key)) {
          continue;
        }
        const nextPath = `${instancePath}/${encodeFragment(key)}`;
        if (!errorSchema(context, nextPath, propertySchema, value[key])) {
          valid = false;
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      // typebox walks with forEach, which skips holes. JSON.parse never
      // produces holes; the check keeps the port exact anyway.
      if (!(index in value)) {
        continue;
      }
      if (!errorSchema(context, `${instancePath}/${index}`, schema.items, value[index])) {
        valid = false;
      }
    }
  }

  if (typeof value === "string" && schema.minLength !== undefined) {
    if (codePointCount(value) < schema.minLength) {
      valid = context.add({ keyword: "minLength", instancePath, detail: schema.minLength });
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    valid = context.add({ keyword: "const", instancePath });
  }

  if (schema.anyOf) {
    // Each operand is evaluated in a fresh context with its own capacity.
    const failed: ErrorContext[] = [];
    let anyPassed = false;
    for (const member of schema.anyOf) {
      const memberContext = new ErrorContext();
      if (errorSchema(memberContext, instancePath, member, value)) {
        anyPassed = true;
      } else {
        failed.push(memberContext);
      }
    }
    if (!anyPassed) {
      for (const memberContext of failed) {
        for (const error of memberContext.errors) {
          context.add(error);
        }
      }
      valid = context.add({ keyword: "anyOf", instancePath });
    }
  }

  return valid;
}

/** typebox `en_US` locale. */
function errorMessage(error: ValidationError): string {
  switch (error.keyword) {
    case "type":
      return `must be ${error.detail}`;
    case "required":
      return `must have required properties ${(error.requiredProperties ?? []).join(", ")}`;
    case "minLength":
      return `must not have fewer than ${error.detail} characters`;
    case "const":
      return "must be equal to constant";
    case "anyOf":
      return "must match a schema in anyOf";
  }
}

/** pi `formatValidationPath`. Only the first missing property is named in the path. */
function formatValidationPath(error: ValidationError): string {
  if (error.keyword === "required") {
    const requiredProperty = error.requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

export type ModelsConfigValidation =
  | { ok: true; config: ModelsConfig }
  /** `errors` is the list pi puts under "Invalid models.json schema:". */
  | { ok: false; errors: string };

/** Validate parsed models.json content against the schema. */
export function validateModelsConfig(parsed: unknown): ModelsConfigValidation {
  const context = new ErrorContext();
  if (errorSchema(context, "", ModelsConfigSchema, parsed)) {
    return { ok: true, config: parsed as ModelsConfig };
  }
  const errors =
    context.errors
      .map((error) => `  - ${formatValidationPath(error)}: ${errorMessage(error)}`)
      .join("\n") || "Unknown schema error";
  return { ok: false, errors };
}
