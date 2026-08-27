/**
 * Pack-content gate (PLAN-41 npm-pack-leak). `npm publish` once shipped a
 * 64MB tarball that included the private audit docs under docs/reviews —
 * a disclosure incident waiting on the "publish" keypress. This script is
 * the tripwire: it dry-runs `npm pack` and fails on anything that must
 * never leave the machine.
 *
 * Run: pnpm release:check   (CI runs it after the build step)
 *
 * Assertions:
 *   1. No internal docs (docs/reviews, docs/plans, docs/debug,
 *      docs/diagnostics) and no keys/ tree.
 *   2. No databases, env files, key material, or logs by extension.
 *   3. The pack actually contains the runtime (dist/index.js, bitterbot.mjs).
 *   4. Tarball + unpacked size ceilings — catches a runaway dist or an
 *      accidentally-included artifact dump before it ships.
 */

import { execFileSync } from "node:child_process";

const FORBIDDEN_PREFIXES = [
  "docs/reviews/",
  "docs/plans/",
  "docs/debug/",
  "docs/diagnostics/",
  "keys/",
  ".bitterbot/",
];

const FORBIDDEN_SUFFIXES = [
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
  ".db",
  ".env",
  ".pem",
  ".log",
  "node.key",
];

const REQUIRED_PATHS = ["dist/index.js", "bitterbot.mjs", "package.json"];

// Current honest footprint is ~63MB packed / ~265MB unpacked (719 dist
// chunks + bundled extensions + skills + public docs). The ceilings leave
// modest headroom; if a legitimate change crosses them, raise them in the
// same commit that explains why.
const MAX_TARBALL_BYTES = 90 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 320 * 1024 * 1024;

type PackReport = {
  files: Array<{ path: string; size: number }>;
  size: number;
  unpackedSize: number;
  filename: string;
};

function main(): void {
  // --ignore-scripts: prepack runs the full build; the gate checks whatever
  // dist is on disk (CI runs it right after its build step).
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm may prefix the JSON with notice lines on some configs — find the array.
  const jsonStart = raw.indexOf("[");
  const report = (JSON.parse(raw.slice(jsonStart)) as PackReport[])[0];
  if (!report) {
    throw new Error("npm pack --json returned no report");
  }

  const failures: string[] = [];
  const paths = new Set(report.files.map((f) => f.path));

  for (const file of report.files) {
    const p = file.path;
    if (FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix))) {
      failures.push(`forbidden tree: ${p}`);
    } else if (FORBIDDEN_SUFFIXES.some((suffix) => p.endsWith(suffix))) {
      failures.push(`forbidden file type: ${p}`);
    }
  }

  for (const required of REQUIRED_PATHS) {
    if (!paths.has(required)) {
      failures.push(`missing from pack (build incomplete?): ${required}`);
    }
  }

  if (report.size > MAX_TARBALL_BYTES) {
    failures.push(
      `tarball ${(report.size / 1e6).toFixed(1)}MB exceeds ceiling ${(MAX_TARBALL_BYTES / 1e6).toFixed(0)}MB`,
    );
  }
  if (report.unpackedSize > MAX_UNPACKED_BYTES) {
    failures.push(
      `unpacked ${(report.unpackedSize / 1e6).toFixed(1)}MB exceeds ceiling ${(MAX_UNPACKED_BYTES / 1e6).toFixed(0)}MB`,
    );
  }

  if (failures.length > 0) {
    console.error(`release-check: ${failures.length} problem(s) in ${report.filename}:`);
    const shown = failures.slice(0, 40);
    for (const f of shown) {
      console.error(`  ✘ ${f}`);
    }
    if (failures.length > shown.length) {
      console.error(`  … and ${failures.length - shown.length} more`);
    }
    process.exit(1);
  }

  console.log(
    `release-check: OK — ${report.files.length} files, ` +
      `${(report.size / 1e6).toFixed(1)}MB packed / ${(report.unpackedSize / 1e6).toFixed(1)}MB unpacked, ` +
      "no internal docs, no databases, no key material.",
  );
}

main();
