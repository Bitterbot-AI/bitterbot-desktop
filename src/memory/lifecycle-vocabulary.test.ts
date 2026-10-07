/**
 * Guard for the two lifecycle columns (Agent Memory Atlas review, 2026-09-19).
 * `lifecycle` and `lifecycle_state` encode one concept in two vocabularies; a
 * query once filtered `lifecycle_state != 'expired'`, a value that column can
 * never hold, and silently returned expired skills as live. This test fails
 * on any SQL in src/ that compares either column with a literal outside that
 * column's own vocabulary. Prefer liveChunkPredicate() for "is it live?".
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATE_VALUES, LIFECYCLE_VALUES } from "./chunk-writer.js";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("lifecycle column vocabularies", () => {
  it("no SQL compares a lifecycle column with the other column's values", () => {
    const allowed: Record<string, readonly string[]> = {
      lifecycle_state: [...LIFECYCLE_STATE_VALUES, "consolidating"], // legacy value read by v19
      lifecycle: LIFECYCLE_VALUES,
    };
    const offenders: string[] = [];
    const re = /\b(lifecycle_state|lifecycle)\s*(?:=|!=|<>)\s*'([a-z_]+)'/g;
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(re)) {
        const [, col, value] = m;
        if (!allowed[col]!.includes(value!)) {
          offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
