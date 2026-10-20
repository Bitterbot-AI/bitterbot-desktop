/**
 * Tool schemas are built with @sinclair/typebox 0.34, whose objects carry a
 * `Symbol.for("TypeBox.Kind")` marker. pi-ai >= 0.73 validates tool arguments
 * with typebox 1.x, and when it sees that marker it skips its JSON Schema
 * coercion step, so LLM output like `{"limit": "5"}` fails with "must be
 * number" where pi-ai 0.52 (Ajv, coerceTypes) accepted it as 5.
 *
 * A symbol-free JSON copy keeps the exact same wire schema (symbols never
 * serialize) and restores the coercion. Copies are cached per schema object.
 */
const plainCache = new WeakMap<object, unknown>();

export function toPlainJsonSchema<T>(schema: T): T {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const cached = plainCache.get(schema);
  if (cached !== undefined) {
    return cached as T;
  }
  const plain = JSON.parse(JSON.stringify(schema)) as T;
  plainCache.set(schema, plain);
  return plain;
}
