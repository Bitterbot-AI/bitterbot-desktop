#!/usr/bin/env node
// Adapted from block/buzz (Apache-2.0) desktop/scripts/check-file-sizes.mjs
//
// Guard: 1000-line max per file under desktop/renderer/src.
//
// Files that blow past ~1000 lines stop being reviewable units and accrete
// unrelated concerns; the cap forces splits before that happens. Files that
// were already over the cap when the guard landed are grandfathered in the
// ALLOWLIST below with their line count at that time — they may not grow
// (fail if they exceed recorded count + 50). New files over 1000 lines fail
// outright.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "renderer", "src");
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const MAX_LINES = 1000;
const GRANDFATHER_SLACK = 50;

// Legacy grandfathering: files already over the cap when this guard landed,
// with their line count at that time. "May not grow": each fails if it
// exceeds its recorded count + 50. Shrink one under 1000 and delete its entry.
const ALLOWLIST = new Map([
  // 1048 lines on 2026-07-29
  ["desktop/renderer/src/components/circles/CirclesView.test.tsx", 1048],
]);

function countLines(content) {
  if (content.length === 0) return 0;
  // wc -l semantics: a trailing newline does not start an extra line.
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return SKIP_DIRS.has(entry.name) ? [] : walk(full);
      }
      return EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
    }),
  );
  return files.flat();
}

const repoRoot = path.resolve(__dirname, "..", "..");
const violations = [];
for (const filePath of await walk(SRC_ROOT)) {
  const rel = path.relative(repoRoot, filePath).split(path.sep).join("/");
  const lines = countLines(await fs.readFile(filePath, "utf8"));
  const recorded = ALLOWLIST.get(rel);
  const limit = recorded === undefined ? MAX_LINES : recorded + GRANDFATHER_SLACK;
  if (lines > limit) {
    violations.push(
      recorded === undefined
        ? `- ${rel}: ${lines} lines (max ${MAX_LINES})`
        : `- ${rel}: ${lines} lines (grandfathered at ${recorded}, may not exceed ${limit})`,
    );
  }
}

if (violations.length > 0) {
  console.error(`file-size check failed (${violations.length} violation(s)):`);
  for (const v of violations) console.error(v);
  console.error(
    `Keep files at or below ${MAX_LINES} lines; grandfathered files may not grow. Split the file instead.`,
  );
  process.exit(1);
}
