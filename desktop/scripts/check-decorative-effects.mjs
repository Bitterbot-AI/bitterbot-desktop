#!/usr/bin/env node
// Guard: decorative effects in the renderer (PLAN-65).
//
// The Control UI is moving to a neutral, flat look: no gradients, no glass
// blur, no coloured glow shadows, no bounce or shimmer. This script counts
// those classes in desktop/renderer/src so the number can only go down.
//
// Modes:
//   (default)            report-only: print totals per pattern and per
//                        directory, exit 0.
//   --list               also print every hit as file:line.
//   --enforce <dir,...>  exit 1 if any hit is under one of the given
//                        directories (relative to renderer/src). Phases of
//                        PLAN-65 add directories here as they are converted.
//   --max <n>            exit 1 if the total exceeds n (ratchet).
//
// A line can opt out with a trailing `decorative-ok: <reason>` comment. Use it
// only where colour or motion carries meaning (hormone and memory charts).

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, "..", "renderer", "src");
const EXTENSIONS = new Set([".ts", ".tsx", ".css"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const ALLOW_MARK = "decorative-ok:";

// A coloured arbitrary shadow: shadow-[0_8px_32px_rgba(139,92,246,0.2)].
// Neutral ones (r == g == b) are ordinary elevation and are not flagged.
const isColoured = (match) =>
  [...match.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].some(
    ([, r, g, b]) => !(r === g && g === b),
  );

// [name, regex, optional filter]. Gradient stops (from-*, to-*) are not
// counted separately: every gradient already has one bg-gradient-* hit.
const PATTERNS = [
  [
    "gradient",
    /\bbg-(?:gradient|linear|radial|conic)-[\w/[\]-]+|\b(?:linear|radial|conic)-gradient\(/g,
  ],
  ["blur", /\bbackdrop-blur(?:-\w+)?\b|backdrop-filter:\s*blur/g],
  ["glow-shadow", /\bshadow-\[[^\]\s]*rgba?\([^\]\s]*\]/g, isColoured],
  [
    "glow-shadow",
    /\bshadow-(?:purple|pink|violet|fuchsia|indigo|blue|cyan|emerald)-\d{2,3}(?:\/\d+)?/g,
  ],
  ["motion", /\banimate-(?:bounce|ping|gradient-x|shimmer|float)\b/g],
  ["text-clip", /\bbg-clip-text\b/g],
];

function parseArgs(argv) {
  const out = { list: false, enforce: [], max: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--enforce") {
      out.enforce = (argv[++i] ?? "")
        .split(",")
        .map((d) => d.trim().replace(/\/+$/, ""))
        .filter(Boolean);
    } else if (a === "--max") {
      out.max = Number(argv[++i]);
      if (!Number.isInteger(out.max) || out.max < 0) {
        console.error("--max needs a non-negative integer");
        process.exit(2);
      }
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
      if (/\.test\.tsx?$/.test(entry.name)) return [];
      return EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
    }),
  );
  return files.flat();
}

const args = parseArgs(process.argv.slice(2));
const hits = [];
for (const filePath of await walk(SRC_ROOT)) {
  const rel = path.relative(SRC_ROOT, filePath).split(path.sep).join("/");
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARK)) return;
    for (const [name, re, keep] of PATTERNS) {
      for (const match of line.match(re) ?? []) {
        if (keep && !keep(match)) continue;
        hits.push({ rel, line: index + 1, name, match });
      }
    }
  });
}

const byPattern = new Map();
const byDir = new Map();
for (const h of hits) {
  byPattern.set(h.name, (byPattern.get(h.name) ?? 0) + 1);
  const parts = h.rel.split("/");
  const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.slice(0, -1).join("/") || ".";
  byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
}
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log(`decorative effects: ${hits.length} hit(s) in desktop/renderer/src`);
for (const [name, n] of sorted(byPattern)) console.log(`  ${String(n).padStart(4)}  ${name}`);
console.log("by directory:");
for (const [dir, n] of sorted(byDir)) console.log(`  ${String(n).padStart(4)}  ${dir}`);
if (args.list) {
  for (const h of hits) console.log(`- desktop/renderer/src/${h.rel}:${h.line}: ${h.match}`);
}

let failed = false;
if (args.enforce.length > 0) {
  const bad = hits.filter((h) =>
    args.enforce.some((d) => h.rel === d || h.rel.startsWith(d + "/")),
  );
  if (bad.length > 0) {
    failed = true;
    console.error(`\ndecorative-effects check failed in enforced paths (${bad.length}):`);
    for (const h of bad) console.error(`- desktop/renderer/src/${h.rel}:${h.line}: ${h.match}`);
    console.error(
      "These paths are converted to the flat PLAN-65 look. Use surface, border and " +
        "shadow tokens instead of gradients, blur, coloured glow or bounce.",
    );
  }
}
if (args.max !== null && hits.length > args.max) {
  failed = true;
  console.error(
    `\ndecorative-effects ratchet failed: ${hits.length} hits, limit ${String(args.max)}.`,
  );
}
process.exit(failed ? 1 : 0);
