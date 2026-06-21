/**
 * SKU canonicalization for the Aubaine group-buy protocol (PLAN-26 §2.4,
 * docs/protocol/aubaine-v1/SPEC.md §8).
 *
 * `sku_canonical` is the join key that decides which buyers' intents and which
 * supplier's offer belong to the same pool. For custom/C2M goods (no universal
 * identifier; specs that drift during interest-check) the primary form is a
 * content hash of the normalized structured spec, so an offer can freeze its
 * spec ("spec-lock") and a buyer who committed to one spec can never be settled
 * into a different one.
 *
 * This module is the TypeScript reference for the canonicalization the protocol
 * test vectors encode; `sku.test.ts` asserts it reproduces them byte-for-byte.
 */
import { createHash } from "node:crypto";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * RFC 8785 (JCS)-style canonical JSON: object keys sorted by UTF-16 code unit,
 * no insignificant whitespace. `Array.prototype.sort()` with no comparator
 * already orders strings by UTF-16 code unit, which is exactly JCS key order.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).toSorted();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Normalize a structured spec before hashing: recursively trim + lowercase
 * string values and drop null/empty fields, so cosmetic differences (casing,
 * whitespace, key order, an omitted-vs-empty field) collapse to one hash.
 */
export function normalizeSpec(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSpec);
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value)) {
      const normalized = normalizeSpec(value[key] as JsonValue);
      if (normalized === null || normalized === "") {
        continue;
      }
      out[key] = normalized;
    }
    return out;
  }
  return value;
}

/**
 * Primary form for custom/C2M goods: `sha256:` + hex(SHA-256(JCS(normalize(spec)))).
 * Two specs match iff this string is byte-equal.
 */
export function canonicalizeSku(spec: JsonValue): string {
  const digest = createHash("sha256")
    .update(canonicalJson(normalizeSpec(spec)), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/**
 * Branded alias (secondary, for any future expansion into branded goods):
 * `brand:` + lower(trim(brand|model|variant)). Out of scope for the C2M MVP.
 */
export function brandedSku(brand: string, model: string, variant = ""): string {
  const parts = [brand, model, variant]
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return `brand:${parts.join("|")}`;
}
