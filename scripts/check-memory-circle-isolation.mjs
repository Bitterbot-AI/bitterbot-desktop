#!/usr/bin/env node
/**
 * R17 (PLAN-38 §5.2): no memory writer reads circle tables.
 *
 * Circle content is peer-authored and untrusted. The memory taint rule keeps
 * "sandbox"/"canvas" in UNTRUSTED_TOKENS so circle prose never becomes
 * recall-eligible memory — but that only holds if the memory engine never
 * reaches into circle tables directly. This guard fails the lint if any file
 * under src/memory references a circle table (`circle_*`, or SQL against the
 * bare `circles` table).
 *
 * Sanctioned exceptions, by name:
 *   - src/memory/circles-store.ts — IS the circles storage layer (it lives in
 *     src/memory for historical reasons; it is not a memory writer).
 *   - src/memory/migrations.ts — defines the schema for every subsystem.
 * Tests are skipped. Everything else in src/memory that wants circle data
 * must go through src/circles service code, which owns the trust boundary.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MEMORY_DIR = join(ROOT, "src", "memory");

const ALLOWED = new Set(["circles-store.ts", "migrations.ts"]);

const CIRCLE_TABLE_RE = /\bcircle_[a-z_]+\b/;
const BARE_CIRCLES_SQL_RE = /\b(from|into|update|join|table)\s+circles\b/i;
// Closes the obvious bypass: a memory file that reaches circle data by
// importing the allowlisted circles-store (or the circles service) and
// calling its readers leaves zero table-token hits. Importing either from
// src/memory is itself the violation.
const CIRCLE_IMPORT_RE = /\bfrom\s+["'][^"']*(?:circles-store|\/circles\/)[^"']*["']/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) yield p;
  }
}

const violations = [];
for (const file of walk(MEMORY_DIR)) {
  const base = file.split("/").pop();
  if (ALLOWED.has(base)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (
      CIRCLE_TABLE_RE.test(line) ||
      BARE_CIRCLES_SQL_RE.test(line) ||
      CIRCLE_IMPORT_RE.test(line)
    ) {
      violations.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    "R17 violation: memory-subsystem code references circle tables.\n" +
      "Circle content is untrusted peer prose; the memory engine must never\n" +
      "read it directly (PLAN-38 §5.2). Route through src/circles instead.\n",
  );
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("check-memory-circle-isolation: OK (R17 holds)");
