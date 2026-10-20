/**
 * Pack-content gate (PLAN-41 npm-pack-leak). `npm publish` once shipped a
 * 64MB tarball that included the private audit docs under docs/reviews —
 * a disclosure incident waiting on the "publish" keypress. This script is
 * the tripwire: it dry-runs `npm pack` and fails on anything that must
 * never leave the machine, or anything a registry install needs and lacks.
 *
 * Two packages are checked:
 *
 *   pnpm release:check
 *     The app's file list (CI runs it after the build step). The npm pack
 *     list of the repo is what scripts/build-release-tarball.mjs copies into
 *     every release tarball, so this gate still guards what ships. Below.
 *
 *   pnpm release:check --npm-publish --dir <launcher package dir>
 *     The published npm package (scripts/npm-package.ts prepare --out <dir>):
 *     a launcher with exactly LAUNCHER_PACKAGE_FILES, no dependencies, no
 *     scripts, a bundle with only `node:` imports, a few hundred KB at most.
 *
 * Assertions for the app file list:
 *   1. No internal docs (docs/reviews, docs/plans, docs/debug,
 *      docs/diagnostics) and no keys/ tree.
 *   2. No databases, env files, key material, or logs by extension.
 *   3. The pack actually contains the runtime (dist/index.js, bitterbot.mjs,
 *      the Control UI, the bin target).
 *   4. Tarball + unpacked size ceilings — catches a runaway dist or an
 *      accidentally-included artifact dump before it ships.
 *   5. Every file an install-time lifecycle script (preinstall, install,
 *      postinstall) runs is in the pack, with every relative module it
 *      imports, and the hooks use no tool a package install lacks (pnpm,
 *      tsx). A registry install of 1.5.0 would have crashed in preinstall:
 *      scripts/ was not in `files`.
 *   6. No `workspace:`/`link:`/`file:` specs in the runtime dependency maps
 *      (npm cannot resolve them from the registry).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LAUNCHER_FILE,
  LAUNCHER_PACKAGE_FILES,
  launcherManifestProblems,
  nonBuiltinImports,
  type PackageManifest,
} from "./npm-package.ts";

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

export const REQUIRED_PATHS = [
  "dist/index.js",
  "dist/entry.js",
  "bitterbot.mjs",
  "package.json",
  // The gateway serves the Control UI from here; without it a package
  // install boots a gateway with no UI.
  "dist/control-ui/index.html",
  // scripts/fetch-orchestrator.mjs (postinstall) reads the orchestrator
  // release version from it.
  "orchestrator/Cargo.toml",
];

/** npm runs these on the consumer's machine for a registry install. */
export const INSTALL_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall"] as const;

// Current honest footprint is ~63MB packed / ~265MB unpacked (719 dist
// chunks + bundled extensions + skills + public docs). The ceilings leave
// modest headroom; if a legitimate change crosses them, raise them in the
// same commit that explains why.
const MAX_TARBALL_BYTES = 90 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 320 * 1024 * 1024;

// The launcher package is about 50 KB of bundle plus README and LICENSE.
const MAX_LAUNCHER_UNPACKED_BYTES = 512 * 1024;

type PackReport = {
  files: Array<{ path: string; size: number }>;
  size: number;
  unpackedSize: number;
  filename: string;
};

const SCRIPT_FILE = /^(?:\.\/)?([\w@.-]+(?:\/[\w@.-]+)*\.(?:mjs|cjs|js|ts|mts|cts|sh))$/;

/** Package-relative files a lifecycle command runs (`node scripts/x.mjs`, `sh ./y.sh`). */
export function lifecycleFileRefs(command: string): string[] {
  const refs: string[] = [];
  for (const token of command.split(/[\s;&|()]+/)) {
    const m = SCRIPT_FILE.exec(token.replace(/^["']|["']$/g, ""));
    if (m?.[1]) {
      refs.push(m[1]);
    }
  }
  return refs;
}

/** Relative specifiers a module imports (static, re-export and literal dynamic). */
export function relativeImports(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (m[1]) {
        out.add(m[1]);
      }
    }
  }
  return [...out];
}

/**
 * Problems with the install-time lifecycle scripts of `pkg` against the pack
 * file list. `readFile` reads a package-relative file from the tree being
 * packed (null when unreadable), to follow its relative imports.
 */
export function lifecycleProblems(params: {
  scripts: Record<string, string> | undefined;
  packPaths: Set<string>;
  readFile: (rel: string) => string | null;
}): string[] {
  const problems: string[] = [];
  for (const hook of INSTALL_LIFECYCLE_SCRIPTS) {
    const command = params.scripts?.[hook];
    if (!command) {
      continue;
    }
    const tool = /(?:^|[\s;&|(])(pnpm|tsx|yarn|bun)(?=\s|$)|--import[= ]tsx/.exec(command);
    if (tool) {
      problems.push(
        `${hook} "${command}" needs ${tool[1] ?? "tsx"}, which a package install does not have`,
      );
    }
    const seen = new Set<string>();
    const queue = lifecycleFileRefs(command).map((file) => ({
      file,
      from: `${hook} "${command}"`,
    }));
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next || seen.has(next.file)) {
        continue;
      }
      seen.add(next.file);
      if (!params.packPaths.has(next.file)) {
        problems.push(`${next.from} needs ${next.file}, which is not in the package`);
        continue;
      }
      const source = params.readFile(next.file);
      if (source === null) {
        continue;
      }
      for (const spec of relativeImports(source)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(next.file), spec));
        queue.push({ file: target, from: `${next.file} (run by ${hook})` });
      }
    }
  }
  return problems;
}

/** Runtime dependency specs npm cannot resolve from the registry. */
export function unresolvableSpecProblems(pkg: PackageManifest): string[] {
  const problems: string[] = [];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (/^(workspace|link|file|portal):/.test(spec)) {
        problems.push(`${field}.${name} is "${spec}", which npm cannot install from the registry`);
      }
    }
  }
  return problems;
}

/** The `bin` targets must ship. */
export function binProblems(pkg: PackageManifest, packPaths: Set<string>): string[] {
  const bin = pkg.bin;
  const targets =
    typeof bin === "string"
      ? [bin]
      : bin && typeof bin === "object"
        ? Object.values(bin as Record<string, string>)
        : [];
  return targets
    .map((t) => t.replace(/^\.\//, ""))
    .filter((t) => !packPaths.has(t))
    .map((t) => `bin target ${t} is not in the package`);
}

/**
 * Problems with the launcher package as `npm pack` sees it: exactly the
 * expected files, the manifest rules, a bundle that imports only `node:`
 * built-ins, and a size that makes `npm install -g` a matter of seconds.
 */
export function launcherPackProblems(params: {
  pkg: PackageManifest;
  packPaths: string[];
  unpackedSize: number;
  bundleSource: string | null;
}): string[] {
  const problems = [...launcherManifestProblems(params.pkg)];
  const expected = new Set<string>([...LAUNCHER_PACKAGE_FILES, "package.json"]);
  for (const p of params.packPaths) {
    if (!expected.has(p)) {
      problems.push(`unexpected file in the launcher package: ${p}`);
    }
  }
  for (const p of expected) {
    if (!params.packPaths.includes(p)) {
      problems.push(`missing from the launcher package: ${p}`);
    }
  }
  if (params.bundleSource === null) {
    problems.push(`${LAUNCHER_FILE} is unreadable`);
  } else {
    if (!params.bundleSource.startsWith("#!/usr/bin/env node\n")) {
      problems.push(`${LAUNCHER_FILE} does not start with a node shebang`);
    }
    const foreign = nonBuiltinImports(params.bundleSource);
    if (foreign.length > 0) {
      problems.push(`${LAUNCHER_FILE} imports non-built-in modules: ${foreign.join(", ")}`);
    }
  }
  if (params.unpackedSize > MAX_LAUNCHER_UNPACKED_BYTES) {
    problems.push(
      `launcher package is ${(params.unpackedSize / 1024).toFixed(0)} KB unpacked, over the ${MAX_LAUNCHER_UNPACKED_BYTES / 1024} KB ceiling`,
    );
  }
  return problems;
}

function npmPackReport(cwd: string): PackReport {
  // --ignore-scripts: prepack runs the full build; the gate checks whatever
  // dist is on disk (CI runs it right after its build step).
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // npm may prefix the JSON with notice lines on some configs — find the array.
  const report = (JSON.parse(raw.slice(raw.indexOf("["))) as PackReport[])[0];
  if (!report) {
    throw new Error("npm pack --json returned no report");
  }
  return report;
}

function checkLauncherPackage(dir: string): void {
  const report = npmPackReport(dir);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as PackageManifest;
  let bundleSource: string | null = null;
  try {
    bundleSource = fs.readFileSync(path.join(dir, LAUNCHER_FILE), "utf8");
  } catch {
    bundleSource = null;
  }
  const failures = launcherPackProblems({
    pkg,
    packPaths: report.files.map((f) => f.path),
    unpackedSize: report.unpackedSize,
    bundleSource,
  });
  if (failures.length > 0) {
    console.error(
      `release-check --npm-publish: ${failures.length} problem(s) in ${report.filename}:`,
    );
    for (const f of failures) {
      console.error(`  ✘ ${f}`);
    }
    process.exit(1);
  }
  console.log(
    `release-check --npm-publish: OK, ${report.filename}: ${report.files.length} files, ` +
      `${(report.unpackedSize / 1024).toFixed(0)} KB unpacked, no dependencies, no scripts.`,
  );
}

function main(argv: string[]): void {
  if (argv.includes("--npm-publish")) {
    const dirIdx = argv.indexOf("--dir");
    const dir = dirIdx >= 0 ? argv[dirIdx + 1] : undefined;
    if (!dir) {
      console.error(
        "usage: pnpm release:check --npm-publish --dir <dir from scripts/npm-package.ts prepare --out>",
      );
      process.exit(2);
    }
    checkLauncherPackage(path.resolve(dir));
    return;
  }
  const root = process.cwd();
  const report = npmPackReport(root);
  const failures: string[] = [];
  const paths = new Set(report.files.map((f) => f.path));
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ) as PackageManifest;
  const readFile = (rel: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };

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

  failures.push(...binProblems(pkg, paths));
  failures.push(...lifecycleProblems({ scripts: pkg.scripts, packPaths: paths, readFile }));
  failures.push(...unresolvableSpecProblems(pkg));

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
    `release-check: OK, ${report.files.length} files, ` +
      `${(report.size / 1e6).toFixed(1)}MB packed / ${(report.unpackedSize / 1e6).toFixed(1)}MB unpacked, ` +
      "no internal docs, no databases, no key material, install hooks self-contained.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
