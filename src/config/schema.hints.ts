import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEPRECATED_PATHS,
  FIELD_DEFAULTS,
  isAdvancedPath,
  isReadOnlyPath,
  TRI_STATE_PATHS,
} from "./schema.defaults.js";
import { FIELD_HELP } from "./schema.help.js";
import { FIELD_LABELS } from "./schema.labels.js";
import { BitterbotSchema } from "./zod-schema.js";
import { sensitive } from "./zod-schema.sensitive.js";

const log = createSubsystemLogger("config/schema");

export type ConfigUiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  itemTemplate?: unknown;
  /**
   * Effective value when the key is unset (PLAN-56 Phase 1). Filled from the
   * zod `.default()` when there is one, overridden by FIELD_DEFAULTS for
   * defaults that are applied at the point of use.
   */
  default?: unknown;
  /** Written by Bitterbot itself; the form renders it as text. */
  readOnly?: boolean;
  /**
   * One sentence explaining why the key is going away. The form never offers
   * it and shows it read-only (with this reason) only when the file sets it.
   */
  deprecated?: string;
  /** Boolean whose unset state means "no override"; rendered with a "(not set)" choice. */
  triState?: boolean;
};

export type ConfigUiHints = Record<string, ConfigUiHint>;

const GROUP_LABELS: Record<string, string> = {
  wizard: "Wizard",
  update: "Update",
  diagnostics: "Diagnostics",
  logging: "Logging",
  gateway: "Gateway",
  nodeHost: "Node Host",
  agents: "Agents",
  tools: "Tools",
  bindings: "Bindings",
  audio: "Audio",
  models: "Models",
  messages: "Messages",
  commands: "Commands",
  session: "Session",
  cron: "Cron",
  hooks: "Hooks",
  ui: "UI",
  browser: "Browser",
  talk: "Talk",
  channels: "Messaging Channels",
  memory: "Memory",
  p2p: "P2P Network",
  circles: "Circles",
  a2a: "Agent-to-Agent",
  forage: "Forage",
  skills: "Skills",
  plugins: "Plugins",
  discovery: "Discovery",
  presence: "Presence",
  voicewake: "Voice Wake",
  review: "Review and Spending",
  usage: "Usage and Budgets",
  payments: "Payments",
  shop: "Shop",
  monitors: "Monitors",
  notifications: "Notifications",
  auth: "Auth Profiles",
  meta: "Config Metadata",
};

const GROUP_ORDER: Record<string, number> = {
  wizard: 20,
  update: 25,
  diagnostics: 27,
  gateway: 30,
  nodeHost: 35,
  agents: 40,
  tools: 50,
  bindings: 55,
  audio: 60,
  models: 70,
  auth: 75,
  messages: 80,
  commands: 85,
  session: 90,
  cron: 100,
  hooks: 110,
  ui: 120,
  browser: 130,
  talk: 140,
  channels: 150,
  memory: 160,
  p2p: 170,
  circles: 175,
  a2a: 180,
  forage: 185,
  review: 190,
  usage: 192,
  payments: 194,
  shop: 196,
  monitors: 198,
  notifications: 199,
  skills: 200,
  plugins: 205,
  discovery: 210,
  presence: 220,
  voicewake: 230,
  logging: 900,
  meta: 950,
};

/**
 * Help rendered under a section title in the Settings form (PLAN-56 Phase 1).
 * One entry per group that needs more than its field help can carry.
 */
export const GROUP_HELP: Record<string, string> = {
  review:
    "Money leaving the node passes three layers: review.spend decides whether a payment is held for your approval (ask) or not (allow); a standing spend grant (Spend Grants page, a2a.payment.consent) lets a matching payee and amount through without asking; and the wallet caps (tools.wallet.perTransactionCapUsd, tools.wallet.sessionSpendCapUsd, tools.wallet.dailySpendLimitUsd, tools.wallet.x402.maxCostPerRequestUsd) are hard ceilings that apply even when a payment is allowed. Card purchases (payments.link, payments.privacy) are approved per purchase in the card provider's app.",
};

const FIELD_PLACEHOLDERS: Record<string, string> = {
  "gateway.remote.url": "ws://host:19001",
  "gateway.remote.tlsFingerprint": "sha256:ab12cd34…",
  "gateway.remote.sshTarget": "user@host",
  "gateway.controlUi.basePath": "/bitterbot",
  "gateway.controlUi.root": "dist/control-ui",
  "gateway.controlUi.allowedOrigins": "https://control.example.com",
  "agents.list[].identity.avatar": "avatars/bitterbot.png",
};

type JsonSchemaNode = Record<string, unknown>;

function asNode(value: unknown): JsonSchemaNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : undefined;
}

/** Non-null `anyOf`/`oneOf` branches, flattened; the node itself when it is not a union. */
function candidateBranches(node: JsonSchemaNode): JsonSchemaNode[] {
  const alts = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (!Array.isArray(alts)) {
    return [node];
  }
  const rest = alts.map(asNode).filter((a): a is JsonSchemaNode => !!a && a.type !== "null");
  return rest.flatMap(candidateBranches);
}

/** Collapse `anyOf`/`oneOf` with a single non-null branch (zod optional/nullable). */
function nonNullBranch(node: JsonSchemaNode): JsonSchemaNode {
  const rest = candidateBranches(node);
  return rest.length === 1 ? rest[0] : node;
}

/** Step one path segment down from `node`, trying every union branch in order. */
function stepInto(node: JsonSchemaNode, part: string): JsonSchemaNode | undefined {
  for (const branch of candidateBranches(node)) {
    let next: JsonSchemaNode | undefined;
    if (part === "*") {
      next = asNode(branch.additionalProperties);
    } else if (part.endsWith("[]")) {
      const prop = asNode(asNode(branch.properties)?.[part.slice(0, -2)]);
      next = prop ? asNode(nonNullBranch(prop).items) : undefined;
    } else {
      next = asNode(asNode(branch.properties)?.[part]);
    }
    if (next) {
      return next;
    }
  }
  return undefined;
}

/**
 * Walk a generated JSON schema along a dotted hint path. `*` descends into a
 * record's additionalProperties, `name[]` into an array's items. A union of
 * shapes (e.g. `array | {inlineButtons}`, or the typed-or-unknown unions in
 * MemorySchema) is searched branch by branch.
 */
export function jsonSchemaNodeAtPath(schema: unknown, path: string): JsonSchemaNode | undefined {
  let cur = asNode(schema);
  if (!cur) {
    return undefined;
  }
  if (path === "") {
    return cur;
  }
  for (const part of path.split(".")) {
    cur = stepInto(cur, part);
    if (!cur) {
      return undefined;
    }
  }
  return nonNullBranch(cur);
}

let cachedJsonSchema: unknown;
function baseJsonSchema(): unknown {
  if (cachedJsonSchema === undefined) {
    cachedJsonSchema = BitterbotSchema.toJSONSchema({ target: "draft-07", unrepresentable: "any" });
  }
  return cachedJsonSchema;
}

/**
 * Zod `.default()` values are only safe to surface on leaf rows: an object
 * default (e.g. `commands` = `{native: "auto", ...}`) would otherwise leak
 * into the group header hint and the form would try to render it.
 */
function leafDefaultFromSchema(schema: unknown, path: string): unknown {
  const node = jsonSchemaNodeAtPath(schema, path);
  if (!node || node.default === undefined) {
    return undefined;
  }
  const value = node.default;
  if (value !== null && typeof value === "object") {
    return undefined;
  }
  return value;
}

/**
 * Non-sensitive field names that happen to match sensitive patterns.
 * These are explicitly excluded from redaction (plugin config) and
 * warnings about not being marked sensitive (base config).
 */
const SENSITIVE_KEY_WHITELIST_SUFFIXES = [
  "maxtokens",
  "maxoutputtokens",
  "maxinputtokens",
  "maxcompletiontokens",
  "contexttokens",
  "totaltokens",
  "tokencount",
  "tokenlimit",
  "tokenbudget",
  "passwordFile",
] as const;
const NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES = SENSITIVE_KEY_WHITELIST_SUFFIXES.map((suffix) =>
  suffix.toLowerCase(),
);

const SENSITIVE_PATTERNS = [/token$/i, /password/i, /secret/i, /api.?key/i];

function isWhitelistedSensitivePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return NORMALIZED_SENSITIVE_KEY_WHITELIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix));
}

function matchesSensitivePattern(path: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));
}

export function isSensitiveConfigPath(path: string): boolean {
  return !isWhitelistedSensitivePath(path) && matchesSensitivePattern(path);
}

export function buildBaseHints(options?: { jsonSchema?: unknown }): ConfigUiHints {
  const hints: ConfigUiHints = {};
  for (const [group, label] of Object.entries(GROUP_LABELS)) {
    hints[group] = {
      label,
      group: label,
      order: GROUP_ORDER[group],
      ...(GROUP_HELP[group] ? { help: GROUP_HELP[group] } : {}),
    };
  }
  for (const [path, label] of Object.entries(FIELD_LABELS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, label } : { label };
  }
  for (const [path, help] of Object.entries(FIELD_HELP)) {
    const current = hints[path];
    hints[path] = current ? { ...current, help } : { help };
  }
  for (const [path, placeholder] of Object.entries(FIELD_PLACEHOLDERS)) {
    const current = hints[path];
    hints[path] = current ? { ...current, placeholder } : { placeholder };
  }
  // Deprecated keys get a hint even without a label so the raw editor (and
  // the load-time warning) can explain them; the form hides `deprecated`.
  for (const [path, reason] of Object.entries(DEPRECATED_PATHS)) {
    hints[path] = { ...hints[path], deprecated: reason };
  }
  // Truth layer (PLAN-56 Phase 1): effective defaults, read-only, advanced.
  const jsonSchema = options?.jsonSchema ?? baseJsonSchema();
  for (const path of Object.keys(hints)) {
    if (!path.includes(".")) {
      continue; // group headers
    }
    const hint = hints[path];
    const schemaDefault = leafDefaultFromSchema(jsonSchema, path);
    const effectiveDefault = path in FIELD_DEFAULTS ? FIELD_DEFAULTS[path] : schemaDefault;
    hints[path] = {
      ...hint,
      ...(effectiveDefault !== undefined ? { default: effectiveDefault } : {}),
      ...(isReadOnlyPath(path) ? { readOnly: true } : {}),
      ...(path in TRI_STATE_PATHS ? { triState: true } : {}),
      ...(hint.advanced === undefined && isAdvancedPath(path) ? { advanced: true } : {}),
    };
  }
  return hints;
}

export function applySensitiveHints(
  hints: ConfigUiHints,
  allowedKeys?: ReadonlySet<string>,
): ConfigUiHints {
  const next = { ...hints };
  for (const key of Object.keys(next)) {
    if (allowedKeys && !allowedKeys.has(key)) {
      continue;
    }
    if (next[key]?.sensitive !== undefined) {
      continue;
    }
    if (isSensitiveConfigPath(key)) {
      next[key] = { ...next[key], sensitive: true };
    }
  }
  return next;
}

// Seems to be the only way tsgo accepts us to check if we have a ZodClass
// with an unwrap() method. And it's overly complex because oxlint and
// tsgo are each forbidding what the other allows.
interface ZodDummy {
  unwrap: () => z.ZodType;
}
function isUnwrappable(object: unknown): object is ZodDummy {
  return (
    !!object &&
    typeof object === "object" &&
    "unwrap" in object &&
    typeof (object as Record<string, unknown>).unwrap === "function" &&
    !(object instanceof z.ZodArray)
  );
}

export function mapSensitivePaths(
  schema: z.ZodType,
  path: string,
  hints: ConfigUiHints,
): ConfigUiHints {
  let next = { ...hints };
  let currentSchema = schema;
  let isSensitive = sensitive.has(currentSchema);

  while (isUnwrappable(currentSchema)) {
    currentSchema = currentSchema.unwrap();
    isSensitive ||= sensitive.has(currentSchema);
  }

  if (isSensitive) {
    next[path] = { ...next[path], sensitive: true };
  } else if (isSensitiveConfigPath(path) && !next[path]?.sensitive) {
    log.warn(`possibly sensitive key found: (${path})`);
  }

  if (currentSchema instanceof z.ZodObject) {
    const shape = currentSchema.shape;
    for (const key in shape) {
      const nextPath = path ? `${path}.${key}` : key;
      next = mapSensitivePaths(shape[key], nextPath, next);
    }
  } else if (currentSchema instanceof z.ZodArray) {
    const nextPath = path ? `${path}[]` : "[]";
    next = mapSensitivePaths(currentSchema.element as z.ZodType, nextPath, next);
  } else if (currentSchema instanceof z.ZodRecord) {
    const nextPath = path ? `${path}.*` : "*";
    next = mapSensitivePaths(currentSchema._def.valueType as z.ZodType, nextPath, next);
  } else if (
    currentSchema instanceof z.ZodUnion ||
    currentSchema instanceof z.ZodDiscriminatedUnion
  ) {
    for (const option of currentSchema.options) {
      next = mapSensitivePaths(option as z.ZodType, path, next);
    }
  } else if (currentSchema instanceof z.ZodIntersection) {
    next = mapSensitivePaths(currentSchema._def.left as z.ZodType, path, next);
    next = mapSensitivePaths(currentSchema._def.right as z.ZodType, path, next);
  }

  return next;
}

/** @internal */
export const __test__ = {
  mapSensitivePaths,
};
