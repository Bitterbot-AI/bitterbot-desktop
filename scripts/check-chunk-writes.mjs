#!/usr/bin/env node
/**
 * PLAN-46 Phase 0 (invariant I1): the shared/clobber-prone columns of the
 * `chunks` table must be written only through src/memory/chunk-writer.ts. A
 * raw `UPDATE chunks SET ... <shared column> ...` anywhere else is the write
 * pattern that let subsystems clobber each other and caused the 2026-09-07
 * audit's lifecycle-divergence bug. New raw writes to these columns fail lint.
 *
 * Enforced columns (this increment): lifecycle, lifecycle_state,
 * provenance_chain, provenance_dag, curiosity_reward. Single-owner columns are
 * not enforced (no clobber risk); later increments extend the set.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const ALLOW = new Set(["src/memory/chunk-writer.ts", "src/memory/migrations.ts"]);
const ENFORCED = [
  "lifecycle",
  "lifecycle_state",
  "provenance_chain",
  "provenance_dag",
  "curiosity_reward",
];
// An UPDATE chunks ... SET ... touching an enforced column. Matches across the
// statement (newlines) up to the WHERE/backtick end.
const UPDATE_RE = /UPDATE\s+chunks\s+SET[\s\S]{0,400}?(?=`|;|WHERE|$)/gi;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      out.push(...walk(p));
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const violations = [];
for (const file of walk(ROOT)) {
  if (ALLOW.has(file.replaceAll("\\", "/"))) continue;
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(UPDATE_RE)) {
    const stmt = m[0];
    const hit = ENFORCED.find((c) => new RegExp(`\\b${c}\\b`).test(stmt));
    if (hit) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(
        `${file}:${line}  raw write to chunks.${hit} — use src/memory/chunk-writer.ts`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("check-chunk-writes: raw writes to enforced chunks columns (PLAN-46 I1):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(
  `check-chunk-writes: OK (I1 holds; ${ENFORCED.length} enforced columns route through chunk-writer.ts)`,
);
