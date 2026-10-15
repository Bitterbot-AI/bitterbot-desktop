/**
 * The npm package: a thin launcher over the signed release tarball.
 *
 *   node --import tsx scripts/npm-package.ts prepare --out <dir> [--root <repo>]
 *
 * Run by .github/workflows/npm-publish.yml and the CI "npm package install"
 * job. It writes a complete, publishable package into <dir>; the repo's own
 * package.json is not touched (it stays the source / release-tarball
 * manifest, with its pnpm-only preinstall/postinstall hooks).
 *
 * Why a launcher instead of the app itself (1.6.0 and 1.6.1 published the
 * whole app: 67 dependencies, about 1,500 packages and 2.3 GB, which took
 * over half an hour to install on a Mac and printed dozens of deprecation
 * and allow-scripts warnings):
 *
 *   - npm 12 blocks install scripts of dependencies on global installs by
 *     default, and a package cannot pre-approve itself; only the user's npm
 *     config can. So the package must need no install scripts at all.
 *   - With no dependencies, `npm install -g bitterbot` downloads a few small
 *     files and finishes in seconds, with nothing to warn about.
 *   - On first run the launcher installs the same signed per-platform release
 *     tarball scripts/install.sh installs (bundled Node, node_modules,
 *     orchestrator), verified the same way (src/launcher/).
 *
 * The package:
 *
 *   package.json   name, version (= the release it installs), bin, engines
 *                  node >=18 (the launcher only downloads; the app brings its
 *                  own Node), NO dependencies, NO scripts of any kind
 *   bitterbot.mjs  the launcher, bundled by esbuild into one file whose only
 *                  imports are `node:` built-ins
 *   dist/entry.js  compat shims (see COMPAT_SHIMS): 1.6.0/1.6.1 gateway
 *   dist/index.js  services and `bitterbot update` point into the package
 *   README.md, LICENSE
 */

import fs from "node:fs";
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
  overrides?: Record<string, string>;
  [key: string]: unknown;
};

/** The launcher bundle, also the `bitterbot` bin target. */
export const LAUNCHER_FILE = "bitterbot.mjs";

/**
 * Paths inside the package that 1.6.0 and 1.6.1 installs still point at
 * after they update to the launcher (`npm i -g bitterbot@latest`, which is
 * what `bitterbot update` runs for a package install):
 *
 *   - dist/index.js: a gateway service installed from the npm package runs
 *     `<node> <prefix>/lib/node_modules/bitterbot/dist/index.js gateway
 *     --port <port>` (src/daemon/program-args.ts resolves the npm bin link
 *     to the package's dist/ entry), from launchd, systemd or schtasks.
 *   - dist/entry.js: right after the npm install, the 1.6.x updater runs
 *     `<node> <pkg>/dist/entry.js doctor --non-interactive`; an older service
 *     may also name entry.js.
 *
 * Each shim imports the launcher, which reads the same argv, so the old
 * command keeps working: it installs the release on first use (the doctor
 * run right after the update usually does this, before the service
 * restarts) and runs it.
 */
export const COMPAT_SHIMS = ["dist/entry.js", "dist/index.js"] as const;

/** Copied from the repo root. */
export const COPIED_FILES = ["README.md", "LICENSE"] as const;

/** Every file the published package contains (package.json is implied). */
export const LAUNCHER_PACKAGE_FILES = [LAUNCHER_FILE, ...COMPAT_SHIMS, ...COPIED_FILES] as const;

/** Oldest Node the launcher runs on; the app itself bundles Node 22. */
export const LAUNCHER_NODE_ENGINE = ">=18";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "overrides",
] as const;

/** `https://github.com/x/y.git` in npm's normalised `git+` form (no publish warning). */
function normalizeRepository(repo: unknown): unknown {
  if (repo && typeof repo === "object" && typeof (repo as { url?: unknown }).url === "string") {
    const url = (repo as { url: string }).url;
    return { ...repo, url: url.startsWith("git+") ? url : `git+${url}` };
  }
  return repo;
}

/** The launcher's package.json, derived from the repo manifest. */
export function launcherManifest(pkg: PackageManifest): PackageManifest {
  if (!pkg.name || !pkg.version) {
    throw new Error("the repo package.json has no name or version");
  }
  const out: PackageManifest = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    keywords: pkg.keywords,
    homepage: pkg.homepage,
    bugs: pkg.bugs,
    license: pkg.license,
    author: pkg.author,
    repository: normalizeRepository(pkg.repository),
    type: "module",
    bin: { bitterbot: LAUNCHER_FILE },
    files: [...LAUNCHER_PACKAGE_FILES],
    engines: { node: LAUNCHER_NODE_ENGINE },
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) {
      delete out[key];
    }
  }
  return out;
}

/**
 * Why the package would not install silently in seconds: any dependency,
 * any script (npm 12 blocks install scripts on global installs and prints
 * allow-scripts warnings; the repo's dev scripts must not leak either), a
 * bin target that is not the launcher.
 */
export function launcherManifestProblems(pkg: PackageManifest): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const value = pkg[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "object" && value !== null && Object.keys(value).length === 0) {
      continue;
    }
    problems.push(`package.json has ${field}: the launcher package must have no dependencies`);
  }
  if (pkg.scripts !== undefined) {
    problems.push(
      `package.json has scripts (${Object.keys(pkg.scripts).join(", ") || "empty"}): the launcher package must have none`,
    );
  }
  const bin = pkg.bin as Record<string, string> | string | undefined;
  if (
    !bin ||
    typeof bin !== "object" ||
    bin.bitterbot !== LAUNCHER_FILE ||
    Object.keys(bin).length !== 1
  ) {
    problems.push(`bin must be exactly { "bitterbot": "${LAUNCHER_FILE}" }`);
  }
  if (pkg.type !== "module") {
    problems.push('type must be "module" (the compat shims are ES modules)');
  }
  const engines = pkg.engines as Record<string, string> | undefined;
  if (engines?.node !== LAUNCHER_NODE_ENGINE) {
    problems.push(`engines.node must be "${LAUNCHER_NODE_ENGINE}"`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version ?? ""))) {
    problems.push(
      `version must be X.Y.Z (the release the launcher installs), got ${String(pkg.version)}`,
    );
  }
  for (const key of ["main", "exports", "gypfile", "pnpm", "packageManager"]) {
    if (key in pkg) {
      problems.push(`package.json must not have "${key}"`);
    }
  }
  return problems;
}

/** Module specifiers a bundle imports or requires that are not `node:` built-ins. */
export function nonBuiltinImports(source: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /^\s*import\s[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec && !spec.startsWith("node:")) {
        out.add(spec);
      }
    }
  }
  return [...out];
}

/** The source of one compat shim: a comment and an import of the launcher. */
export function compatShimSource(shim: string): string {
  let rel = path.posix.relative(path.posix.dirname(shim), LAUNCHER_FILE);
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return [
    "// Compatibility shim. Up to 1.6.1 the bitterbot npm package was the whole",
    "// app, and gateway services and the 1.6.x updater run files inside it",
    "// directly (node <package>/dist/index.js gateway, <package>/dist/entry.js",
    "// doctor). The package is now a small launcher that installs the signed",
    "// release on first run, so those commands continue there.",
    `import "${rel}";`,
    "",
  ].join("\n");
}

/** Bundle src/launcher/main.ts into one ESM file with only `node:` imports. */
export async function buildLauncherBundle(params: {
  root: string;
  outfile: string;
  version: string;
}): Promise<string> {
  const esbuild = await import("esbuild");
  await esbuild.build({
    entryPoints: [path.join(params.root, "src", "launcher", "main.ts")],
    outfile: params.outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    legalComments: "none",
    logLevel: "warning",
    define: { __BITTERBOT_LAUNCHER_VERSION__: JSON.stringify(params.version) },
    banner: {
      js: [
        "#!/usr/bin/env node",
        `// bitterbot ${params.version} launcher: installs the signed release tarball on`,
        "// first run, then runs it. Source: src/launcher/ in",
        "// https://github.com/Bitterbot-AI/bitterbot-desktop (built by scripts/npm-package.ts).",
      ].join("\n"),
    },
  });
  const source = fs.readFileSync(params.outfile, "utf8");
  const foreign = nonBuiltinImports(source);
  if (foreign.length > 0) {
    throw new Error(`the launcher bundle imports non-built-in modules: ${foreign.join(", ")}`);
  }
  fs.chmodSync(params.outfile, 0o755);
  return source;
}

/** Write the complete launcher package into `out` (emptied first). */
export async function prepareLauncherPackage(params: {
  root: string;
  out: string;
}): Promise<PackageManifest> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(params.root, "package.json"), "utf8"),
  ) as PackageManifest;
  const manifest = launcherManifest(pkg);
  const problems = launcherManifestProblems(manifest);
  if (problems.length > 0) {
    throw new Error(`launcher manifest problems:\n  ${problems.join("\n  ")}`);
  }
  fs.rmSync(params.out, { recursive: true, force: true });
  fs.mkdirSync(params.out, { recursive: true });
  await buildLauncherBundle({
    root: params.root,
    outfile: path.join(params.out, LAUNCHER_FILE),
    version: String(manifest.version),
  });
  for (const shim of COMPAT_SHIMS) {
    fs.mkdirSync(path.join(params.out, path.dirname(shim)), { recursive: true });
    fs.writeFileSync(path.join(params.out, shim), compatShimSource(shim));
  }
  for (const file of COPIED_FILES) {
    fs.copyFileSync(path.join(params.root, file), path.join(params.out, file));
  }
  fs.writeFileSync(path.join(params.out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function argValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const out = argValue(rest, "--out");
  if (command !== "prepare" || !out) {
    console.error(
      "usage: node --import tsx scripts/npm-package.ts prepare --out <dir> [--root <repo>]",
    );
    process.exit(2);
  }
  const root = path.resolve(argValue(rest, "--root") ?? ".");
  const manifest = await prepareLauncherPackage({ root, out: path.resolve(out) });
  console.log(
    `npm-package: wrote the bitterbot ${String(manifest.version)} launcher package to ${path.resolve(out)} (no dependencies, no scripts).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`npm-package: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
