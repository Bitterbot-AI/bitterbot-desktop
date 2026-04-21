#!/usr/bin/env node
// Build the gateway as a single-executable Node SEA binary for a given
// Rust target triple, matching the filename convention Tauri's sidecar
// resolver expects: binaries/bitterbot-gateway-<rust-triple>[.exe]
//
// Usage (from repo root):
//   node scripts/build-sea.mjs --target x86_64-unknown-linux-gnu
//
// Requires: node >= 22 (SEA is stable since 22).
// Outputs:  desktop/src-tauri/binaries/bitterbot-gateway-<target>[.exe]
//
// Per-target behavior:
//   - We do NOT cross-compile. Each CI runner builds its native target only.
//   - esbuild bundles the gateway TS entry + deps into a single .mjs.
//   - node --experimental-sea-config produces sea-prep.blob.
//   - postject injects the blob into a copy of the current `node` binary.
//   - On macOS, we strip any pre-existing signature so code signing can
//     re-sign the modified binary.
//
// See research/TAURI-PRODUCTION-PLAN.md §2 for the full rationale.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OUT_DIR = join(REPO_ROOT, "desktop", "src-tauri", "binaries");
const WORK_DIR = join(REPO_ROOT, "desktop", "src-tauri", ".sea-work");
const GATEWAY_ENTRY = join(REPO_ROOT, "scripts", "run-node.mjs");

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    help: { type: "boolean" },
  },
});

if (values.help || !values.target) {
  console.error(
    `Usage: node scripts/build-sea.mjs --target <rust-target-triple>\n` +
      `Supported targets:\n` +
      `  x86_64-pc-windows-msvc\n` +
      `  x86_64-apple-darwin\n` +
      `  aarch64-apple-darwin\n` +
      `  x86_64-unknown-linux-gnu\n`,
  );
  process.exit(values.help ? 0 : 1);
}

const target = values.target;
const isWindows = target.includes("windows");
const isMac = target.includes("apple-darwin");
const outName = `bitterbot-gateway-${target}${isWindows ? ".exe" : ""}`;
const outPath = join(OUT_DIR, outName);

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (result.status !== 0) {
    throw new Error(`Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

// Sanity check Node version — SEA is stable since 22.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
  console.error(`Node ${process.versions.node} is too old. Need >= 22 for SEA.`);
  process.exit(1);
}

// Verify target matches the host platform — we don't cross-compile SEA.
const hostTripleGuess = (() => {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32") {
    return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return "unknown";
})();

if (target !== hostTripleGuess) {
  console.warn(
    `WARNING: target ${target} does not match detected host ${hostTripleGuess}. ` +
      `SEA does not cross-compile. Output binary will only run on ${hostTripleGuess}.`,
  );
}

// Clean work dir.
rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(WORK_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// 1. Bundle the gateway entry with esbuild into a single ESM file.
// We expect `esbuild` to be available via npx (ships with many dev deps).
// If the project adds esbuild as a direct devDep, prefer that path.
const bundledPath = join(WORK_DIR, "gateway-bundled.mjs");
console.log(`[1/5] Bundling ${GATEWAY_ENTRY} with esbuild`);
run("npx", [
  "--yes",
  "esbuild",
  GATEWAY_ENTRY,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  // better-sqlite3 ships a native .node addon. Mark it external so the
  // bundler doesn't try to inline the binary. We copy the .node file
  // alongside the SEA binary and reference it at runtime.
  "--external:better-sqlite3",
  // Other native-modulish deps likely need the same treatment. Add here
  // as they surface during first build on each platform.
  `--outfile=${bundledPath}`,
]);

// 2. Write sea-config.json pointing at the bundled entry.
const seaConfigPath = join(WORK_DIR, "sea-config.json");
const seaBlobPath = join(WORK_DIR, "sea-prep.blob");
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundledPath,
      output: seaBlobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
      assets: {},
    },
    null,
    2,
  ),
);

// 3. Generate the SEA blob.
console.log(`[2/5] Generating SEA blob`);
run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

// 4. Copy the current node executable to the output path.
console.log(`[3/5] Copying Node binary to ${outPath}`);
cpSync(process.execPath, outPath);
// Ensure executable bit on Unix. cpSync should preserve perms, but be defensive.
if (!isWindows) {
  spawnSync("chmod", ["+x", outPath]);
}

// 5. On macOS, strip the existing codesign signature so postject can
// modify the binary and so we can re-sign later with our Developer ID.
if (isMac) {
  console.log(`[4/5] Stripping existing codesign signature`);
  // codesign --remove-signature is tolerant of already-unsigned binaries.
  spawnSync("codesign", ["--remove-signature", outPath], { stdio: "inherit" });
}

// 6. Inject the SEA blob via postject.
// The fuse sentinel is fixed by Node for SEA; do not change.
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
console.log(`[${isMac ? "5" : "4"}/5] Injecting SEA blob`);
const postjectArgs = [
  "--yes",
  "postject",
  outPath,
  "NODE_SEA_BLOB",
  seaBlobPath,
  "--sentinel-fuse",
  SEA_FUSE,
];
if (isMac) {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run("npx", postjectArgs);

// Optional: re-sign with ad-hoc identity on macOS for local testing.
// Real CI runs do this as part of the Tauri bundling step.
if (isMac && !process.env.CI) {
  spawnSync("codesign", ["--sign", "-", outPath], { stdio: "inherit" });
}

// 7. Copy the better-sqlite3 .node addon alongside the binary. Tauri's
// resource bundler needs to include this. Path varies by platform.
// Note: deferred; handled once we know the exact runtime lookup path
// from inside the SEA binary. For now leave a TODO marker.
// TODO(SEA-native-modules): resolve native bindings path at build time
// and emit into desktop/src-tauri/resources/ or alongside the sidecar.
const nodeModulesAddonPath = join(
  REPO_ROOT,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
if (existsSync(nodeModulesAddonPath)) {
  const resourcesDir = join(REPO_ROOT, "desktop", "src-tauri", "resources");
  mkdirSync(resourcesDir, { recursive: true });
  const addonOutPath = join(resourcesDir, "better_sqlite3.node");
  cpSync(nodeModulesAddonPath, addonOutPath);
  console.log(`     copied native addon to ${addonOutPath}`);
} else {
  console.warn(
    `     better_sqlite3.node not found at ${nodeModulesAddonPath}; skipping.\n` +
      `     Run pnpm install --frozen-lockfile first, or adjust the path for your platform.`,
  );
}

console.log(`\nDone. Sidecar binary: ${outPath}`);
console.log(`     Size: ${(readFileSync(outPath).length / 1024 / 1024).toFixed(1)} MB`);
