/**
 * Make a failed argument validation tell the model what would have passed.
 *
 * The validator's message for a wrong enum value is "must be equal to one of
 * the allowed values", without the values. On 2026-10-02 an agent that wanted
 * to read a page tried `read`, `content`, `help`, `evaluate`, `extract` and
 * `text` against the browser tool before it guessed `snapshot`: six wasted
 * calls for want of one line. This appends that line.
 */

const MAX_VALUES = 40;
const MAX_HINT_CHARS = 600;

type JsonSchema = {
  enum?: unknown;
  const?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  properties?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fixed set of values a property accepts, if its schema is such a set. */
function allowedValues(schema: unknown): unknown[] | null {
  if (!isRecord(schema)) {
    return null;
  }
  const s = schema as JsonSchema;
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum;
  }
  // A union of literals: how TypeBox writes an enum.
  const union = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (union && union.length > 0) {
    const values: unknown[] = [];
    for (const member of union) {
      if (!isRecord(member)) {
        return null;
      }
      if ("const" in member) {
        values.push(member.const);
      } else if (Array.isArray(member.enum)) {
        values.push(...member.enum);
      } else {
        return null;
      }
    }
    return values.length > 0 ? values : null;
  }
  return null;
}

/**
 * For each top-level argument whose value is not one its schema allows, a line
 * naming the values that are. Empty when there is nothing useful to add.
 */
export function enumHintsForArguments(parameters: unknown, args: unknown): string {
  if (!isRecord(parameters) || !isRecord(parameters.properties) || !isRecord(args)) {
    return "";
  }
  const lines: string[] = [];
  for (const [name, schema] of Object.entries(parameters.properties)) {
    if (!(name in args)) {
      continue;
    }
    const allowed = allowedValues(schema);
    if (!allowed || allowed.includes(args[name])) {
      continue;
    }
    const shown = allowed.slice(0, MAX_VALUES).map((value) => JSON.stringify(value));
    const more = allowed.length > MAX_VALUES ? `, and ${allowed.length - MAX_VALUES} more` : "";
    lines.push(`Allowed values for "${name}": ${shown.join(", ")}${more}.`);
  }
  return lines.join("\n").slice(0, MAX_HINT_CHARS);
}

/** The validator's message, followed by the allowed values it left out. */
export function withEnumHints(message: string, parameters: unknown, args: unknown): string {
  const hints = enumHintsForArguments(parameters, args);
  return hints ? `${message}\n\n${hints}` : message;
}

/**
 * Reject a call whose string argument is not one of a string enum's values,
 * with the values in the message. For loops whose validator we do not own
 * (the pi engine validates inside the library and reports nothing useful):
 * this runs first, from the tool's `prepareArguments` hook.
 *
 * Deliberately narrow. The library coerces before it validates ("1" passes a
 * numeric enum), so anything that is not plainly a wrong string is left to it.
 */
export function rejectUnknownEnumStrings(toolName: string, parameters: unknown, args: unknown) {
  if (!isRecord(parameters) || !isRecord(parameters.properties) || !isRecord(args)) {
    return;
  }
  const wrong: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(parameters.properties)) {
    const value = args[name];
    const allowed = allowedValues(schema);
    if (
      typeof value === "string" &&
      allowed &&
      allowed.every((candidate) => typeof candidate === "string") &&
      !allowed.includes(value)
    ) {
      wrong[name] = schema;
    }
  }
  const names = Object.keys(wrong);
  if (names.length === 0) {
    return;
  }
  const hints = enumHintsForArguments({ properties: wrong }, args);
  throw new Error(
    `Validation failed for tool "${toolName}":\n` +
      names
        .map((name) => `  - ${name}: ${JSON.stringify(args[name])} is not an allowed value`)
        .join("\n") +
      `\n\n${hints}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
  );
}
