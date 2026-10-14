/**
 * The npm view of the package: what `npm install -g bitterbot` gets that a
 * pnpm source checkout does not need.
 *
 *   node --import tsx scripts/npm-package.ts prepare [--root <dir>]
 *
 * Run by .github/workflows/npm-publish.yml (and the CI "npm package install"
 * job) after `pnpm build` and before `npm pack` / `npm publish`. It rewrites
 * package.json in place and writes npm-shrinkwrap.json next to it, so run it
 * on a CI checkout, not on a working tree you care about.
 *
 * Why a publish-time step instead of committed fields:
 *
 * 1. Optional peers. `@napi-rs/canvas` (PDF image extraction) and
 *    `node-llama-cpp` (keyless local embeddings) are lazily imported and
 *    every caller handles their absence. npm 7+ installs peers automatically,
 *    and node-llama-cpp pulls about 730 MB of GPU builds on linux-x64, so the
 *    published manifest marks them optional in `peerDependenciesMeta`. The
 *    committed package.json cannot carry that: pnpm's autoInstallPeers skips
 *    OPTIONAL peers, which would drop node-llama-cpp from source checkouts,
 *    the Docker image and the release tarball.
 *
 * 2. Security overrides. npm reads `overrides` only from the ROOT project, and
 *    for `npm install -g bitterbot` the root is npm's global prefix, not this
 *    package, so the committed `overrides` field alone protects nobody who
 *    installs from the registry. A published npm-shrinkwrap.json is the one
 *    lockfile npm honours for a dependency: it is resolved here WITH the
 *    overrides applied and checked so every overridden package carries the
 *    pinned version.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PackageManifest = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  overrides?: Record<string, string>;
  [key: string]: unknown;
};

export type Shrinkwrap = {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>;
};

/** Peers the published package must not make npm download. */
export const NPM_OPTIONAL_PEERS = ["@napi-rs/canvas", "node-llama-cpp"] as const;

/** The manifest `npm publish` ships: every listed optional peer marked optional. */
export function npmPublishManifest(pkg: PackageManifest): PackageManifest {
  const peers = pkg.peerDependencies ?? {};
  const meta: Record<string, { optional?: boolean }> = { ...pkg.peerDependenciesMeta };
  for (const name of NPM_OPTIONAL_PEERS) {
    if (name in peers) {
      meta[name] = { ...meta[name], optional: true };
    }
  }
  if (Object.keys(meta).length === 0) {
    return { ...pkg };
  }
  // Keep the key next to peerDependencies so the published manifest reads
  // like a hand-written one.
  const out: PackageManifest = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key === "peerDependenciesMeta") {
      continue;
    }
    out[key] = value;
    if (key === "peerDependencies") {
      out.peerDependenciesMeta = meta;
    }
  }
  if (!("peerDependenciesMeta" in out)) {
    out.peerDependenciesMeta = meta;
  }
  return out;
}

/** Problems with a manifest that claims to be the npm publish manifest. */
export function npmPublishManifestProblems(pkg: PackageManifest): string[] {
  // Every peer, not just the listed ones: a new required peer would be
  // auto-installed for every npm user, so it has to be a conscious choice
  // (add it to NPM_OPTIONAL_PEERS, or make it a real dependency).
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
    if (pkg.peerDependenciesMeta?.[name]?.optional !== true) {
      problems.push(
        `peer ${name}@${spec} would be auto-installed by npm: not optional in peerDependenciesMeta (scripts/npm-package.ts prepare marks NPM_OPTIONAL_PEERS)`,
      );
    }
  }
  return problems;
}

/**
 * The manifest the shrinkwrap is resolved from: devDependencies and scripts
 * removed (npm never installs a dependency's devDependencies, and resolution
 * must not run lifecycle hooks).
 */
export function shrinkwrapInputManifest(pkg: PackageManifest): PackageManifest {
  const { devDependencies: _dev, scripts: _scripts, ...rest } = npmPublishManifest(pkg);
  return rest;
}

function parseExact(version: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareExact(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The exact version each npm override pins. npm requires `"$name"` for a
 * package that is also a direct dependency (any other value is EOVERRIDE),
 * which resolves to that dependency's spec.
 */
export function expectedOverrideVersions(pkg: PackageManifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(pkg.overrides ?? {})) {
    const spec = value.startsWith("$") ? pkg.dependencies?.[value.slice(1)] : value;
    if (spec && parseExact(spec)) {
      out.set(name, spec);
    }
  }
  return out;
}

/**
 * Keeps package.json `overrides` (npm) in step with pnpm-workspace.yaml
 * `overrides` (pnpm): same packages, same pins. For a direct dependency npm
 * needs `"$name"`; that is accepted when the dependency is pinned to an exact
 * version at or above the pnpm pin, so the security floor holds for npm too.
 */
export function overrideSyncProblems(params: {
  npmOverrides: Record<string, string> | undefined;
  pnpmOverrides: Record<string, string> | undefined;
  dependencies: Record<string, string> | undefined;
}): string[] {
  const npm = params.npmOverrides ?? {};
  const pnpm = params.pnpmOverrides ?? {};
  const deps = params.dependencies ?? {};
  const problems: string[] = [];
  for (const [name, pin] of Object.entries(pnpm)) {
    const value = npm[name];
    if (value === undefined) {
      problems.push(`${name}: in pnpm-workspace.yaml overrides (${pin}) but not in package.json`);
      continue;
    }
    if (value === pin) {
      if (name in deps) {
        problems.push(
          `${name}: is a direct dependency, so npm needs "$${name}" (a literal pin is EOVERRIDE)`,
        );
      }
      continue;
    }
    if (value !== `$${name}`) {
      problems.push(`${name}: npm override "${value}" differs from the pnpm pin "${pin}"`);
      continue;
    }
    const direct = parseExact(deps[name]);
    const floor = parseExact(pin);
    if (!direct) {
      problems.push(
        `${name}: "$${name}" needs ${name} pinned to an exact version in dependencies (got "${deps[name] ?? "nothing"}")`,
      );
    } else if (floor && compareExact(direct, floor) < 0) {
      problems.push(`${name}: dependency ${deps[name]} is below the pnpm security pin ${pin}`);
    }
  }
  for (const name of Object.keys(npm)) {
    if (!(name in pnpm)) {
      problems.push(`${name}: in package.json overrides but not in pnpm-workspace.yaml`);
    }
  }
  return problems;
}

/** Every installed copy of an overridden package must carry the pinned version. */
export function shrinkwrapOverrideViolations(
  shrinkwrap: Shrinkwrap,
  expected: Map<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(shrinkwrap.packages ?? {})) {
    const idx = key.lastIndexOf("node_modules/");
    if (idx < 0 || entry.dev || entry.link) {
      continue;
    }
    const name = key.slice(idx + "node_modules/".length);
    const want = expected.get(name);
    if (want && entry.version !== want) {
      problems.push(`${key} is ${entry.version ?? "unversioned"}, override pins ${want}`);
    }
  }
  return problems;
}

/** Resolve npm-shrinkwrap.json for `pkg` in a scratch directory (network). */
export function resolveShrinkwrap(pkg: PackageManifest): Shrinkwrap {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bitterbot-shrinkwrap-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(shrinkwrapInputManifest(pkg), null, 2)}\n`,
    );
    execFileSync(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--lockfile-version",
        "3",
      ],
      { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
    );
    return JSON.parse(fs.readFileSync(path.join(dir, "package-lock.json"), "utf8")) as Shrinkwrap;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function prepare(root: string): void {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageManifest;
  const published = npmPublishManifest(pkg);
  const manifestProblems = npmPublishManifestProblems(published);
  if (manifestProblems.length > 0) {
    throw new Error(`npm manifest problems:\n  ${manifestProblems.join("\n  ")}`);
  }
  const shrinkwrap = resolveShrinkwrap(published);
  const violations = shrinkwrapOverrideViolations(shrinkwrap, expectedOverrideVersions(published));
  if (violations.length > 0) {
    throw new Error(`npm-shrinkwrap.json ignores the overrides:\n  ${violations.join("\n  ")}`);
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(published, null, 2)}\n`);
  fs.writeFileSync(
    path.join(root, "npm-shrinkwrap.json"),
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
  );
  const count = Object.keys(shrinkwrap.packages ?? {}).length - 1;
  console.log(
    `npm-package: package.json marks ${NPM_OPTIONAL_PEERS.join(", ")} optional; ` +
      `npm-shrinkwrap.json pins ${count} packages with the overrides applied.`,
  );
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const rootFlag = rest.indexOf("--root");
  const root = path.resolve(rootFlag >= 0 ? (rest[rootFlag + 1] ?? ".") : ".");
  if (command !== "prepare") {
    console.error("usage: node --import tsx scripts/npm-package.ts prepare [--root <dir>]");
    process.exit(2);
  }
  prepare(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`npm-package: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
