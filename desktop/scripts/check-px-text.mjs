#!/usr/bin/env node
// Adapted from block/buzz (Apache-2.0) desktop/scripts/check-px-text.mjs
//
// Guard: no arbitrary Tailwind font-size literals in the renderer.
//
// Zoom (Ctrl/Cmd +/-) scales the root <html> font-size, so only rem-based
// text scales with it. px literals (`text-[10px]`) freeze against zoom, and
// arbitrary rem literals (`text-[0.8rem]`) re-fragment the consolidated type
// scale. All text sizes must sit on the token scale
// (text-3xs / text-2xs / text-badge / text-xs / text-sm / ...) so the size
// lives in the Tailwind theme as rem and stays on one scale.
//
// Any `text-[<number>px]` or `text-[<number>rem]` hit in
// desktop/renderer/src (.ts/.tsx) fails the check with file:line.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "renderer", "src");
const EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const PX_TEXT_RE = /text-\[[0-9.]+(px|rem)\]/g;

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

const violations = [];
for (const filePath of await walk(SRC_ROOT)) {
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const matches = line.match(PX_TEXT_RE);
    if (!matches) return;
    const rel = path
      .relative(path.resolve(__dirname, "..", ".."), filePath)
      .split(path.sep)
      .join("/");
    for (const match of matches) {
      violations.push(`${rel}:${index + 1}: ${match}`);
    }
  });
}

if (violations.length > 0) {
  console.error(`px-text check failed (${violations.length} violation(s)):`);
  for (const v of violations) console.error(`- ${v}`);
  console.error(
    "px/rem font-size literals break rem-based zoom scaling. Use a token from " +
      "the type scale instead (text-3xs / text-2xs / text-badge / text-xs / text-sm / ...).",
  );
  process.exit(1);
}
