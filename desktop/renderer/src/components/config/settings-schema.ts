/**
 * PLAN-56 Phase 1: pure helpers behind the Settings form. They turn the
 * gateway's `config.schema` (a draft-07 JSON schema generated from zod) and
 * its uiHints into "which control do I render for this path, with what
 * options, and what does it show when the key is unset".
 */

export type JsonSchemaNode = Record<string, unknown>;

export type UiHint = {
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  default?: unknown;
  readOnly?: boolean;
  deprecated?: string;
};

export type ControlKind = "boolean" | "enum" | "number" | "string" | "unknown";

export type ControlSpec = {
  kind: ControlKind;
  /** Enum choices, in schema order. `null` is kept so the select can offer "not set". */
  options?: Array<string | number | boolean | null>;
  /** The schema allows `null` for this leaf. */
  nullable?: boolean;
};

function asNode(value: unknown): JsonSchemaNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonSchemaNode)
    : undefined;
}

function branches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  const alts = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (!Array.isArray(alts)) {
    return undefined;
  }
  return alts.map(asNode).filter((a): a is JsonSchemaNode => !!a);
}

/** Collapse `anyOf`/`oneOf` that is just "T or null" down to T. */
function nonNullBranch(node: JsonSchemaNode): JsonSchemaNode {
  const alts = branches(node);
  if (alts) {
    const rest = alts.filter((a) => a.type !== "null");
    if (rest.length === 1) {
      return nonNullBranch(rest[0]);
    }
  }
  return node;
}

/**
 * Walk the JSON schema along a dotted hint path. `*` descends into a record's
 * additionalProperties, `name[]` into an array's items. Intermediate "T or
 * null" unions are collapsed to T; the final node is returned as-is so the
 * caller can still see that it is nullable.
 */
export function schemaNodeAtPath(schema: unknown, path: string): JsonSchemaNode | undefined {
  let cur = asNode(schema);
  if (!cur) {
    return undefined;
  }
  if (path === "") {
    return cur;
  }
  for (const part of path.split(".")) {
    cur = nonNullBranch(cur);
    if (part === "*") {
      cur = asNode(cur.additionalProperties);
    } else if (part.endsWith("[]")) {
      const prop = asNode(asNode(cur.properties)?.[part.slice(0, -2)]);
      cur = prop ? asNode(nonNullBranch(prop).items) : undefined;
    } else {
      cur = asNode(asNode(cur.properties)?.[part]);
    }
    if (!cur) {
      return undefined;
    }
  }
  return cur;
}

function isNullable(node: JsonSchemaNode): boolean {
  if (node.type === "null" || (Array.isArray(node.type) && node.type.includes("null"))) {
    return true;
  }
  const alts = branches(node);
  return !!alts && alts.some((a) => a.type === "null" || a.const === null);
}

function enumOptions(node: JsonSchemaNode): Array<string | number | boolean | null> | undefined {
  if (Array.isArray(node.enum)) {
    return node.enum as Array<string | number | boolean | null>;
  }
  if ("const" in node) {
    return [node.const as string | number | boolean | null];
  }
  if (node.type === "boolean") {
    return [true, false];
  }
  const alts = branches(node);
  if (!alts || alts.length === 0) {
    return undefined;
  }
  const out: Array<string | number | boolean | null> = [];
  for (const alt of alts) {
    if (alt.type === "null") {
      out.push(null);
      continue;
    }
    const sub = enumOptions(alt);
    if (!sub) {
      return undefined; // a free-form branch: not an enum
    }
    out.push(...sub);
  }
  return out;
}

function typeOf(node: JsonSchemaNode): string | undefined {
  const t = node.type;
  if (typeof t === "string") {
    return t;
  }
  if (Array.isArray(t)) {
    const rest = t.filter((x) => x !== "null");
    return rest.length === 1 ? String(rest[0]) : undefined;
  }
  return undefined;
}

/**
 * Pick the control for a leaf. The schema wins; when it says nothing useful
 * (passthrough objects, `unrepresentable: "any"`), fall back to the value's
 * own type so a row never renders a control that cannot hold its value.
 */
export function controlKindFor(node: JsonSchemaNode | undefined, value: unknown): ControlSpec {
  if (node) {
    const options = enumOptions(node);
    if (options?.some((o) => o !== null)) {
      // A boolean union is still a switch, not a two-option select.
      if (options.every((o) => typeof o === "boolean" || o === null)) {
        return { kind: "boolean", nullable: options.includes(null) };
      }
      return { kind: "enum", options, nullable: isNullable(node) };
    }
    const t = typeOf(nonNullBranch(node));
    if (t === "boolean") {
      return { kind: "boolean", nullable: isNullable(node) };
    }
    if (t === "number" || t === "integer") {
      return { kind: "number", nullable: isNullable(node) };
    }
    if (t === "string") {
      return { kind: "string", nullable: isNullable(node) };
    }
    if (t === "object" || t === "array") {
      return { kind: "unknown" };
    }
  }
  switch (typeof value) {
    case "boolean":
      return { kind: "boolean" };
    case "number":
      return { kind: "number" };
    case "string":
      return { kind: "string" };
    default:
      return { kind: "unknown" };
  }
}

/** A hint path the form can show as a single row. */
export function isLeafHintPath(path: string): boolean {
  return path.includes(".") && !path.includes("*") && !path.includes("[]");
}

/** Value a freshly added row starts with. */
export function initialValueFor(spec: ControlSpec, node: JsonSchemaNode | undefined): unknown {
  if (
    node &&
    node.default !== undefined &&
    (node.default === null || typeof node.default !== "object")
  ) {
    return node.default;
  }
  switch (spec.kind) {
    case "boolean":
      return false;
    case "number":
      return 0;
    case "enum":
      return spec.options?.find((o) => o !== null) ?? "";
    default:
      return "";
  }
}

/** Primitive value, or undefined for objects/arrays the form cannot show inline. */
export function primitiveOrUndefined(value: unknown): string | number | boolean | undefined {
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return value as string | number | boolean;
  }
  return undefined;
}
