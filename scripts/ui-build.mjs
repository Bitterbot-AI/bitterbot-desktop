#!/usr/bin/env node
/**
 * PLAN-39 Phase 1: build the Control UI and stage it for the gateway.
 *
 * `pnpm ui:build` deliberately reuses the name the update flow's progress labels
 * already expect (src/cli/update-cli/progress.ts:24-26), which have been emitted
 * by nothing since the original design was abandoned.
 *
 * The build is content-hash gated, because this runs inside `update.run` where
 * every second is time the node is not serving:
 * `vite build` is skipped when no build input has changed since the last
 * successful build: the renderer, the desktop build config and package files,
 * the lockfile, the root package version and the VITE_* environment (see
 * scripts/ui-build-lib.mjs). Pass --force to rebuild regardless.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeUiInputHash } from "./ui-build-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(repoRoot, "desktop");
const outDir = path.join(desktopDir, "dist-renderer");
const stampDir = path.join(repoRoot, "node_modules", ".cache", "bitterbot");
const force = process.argv.includes("--force");

const log = (msg) => console.log(`[ui:build] ${msg}`);

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) {
    console.error(`[ui:build] \`${cmd} ${args.join(" ")}\` failed with code ${res.status}`);
    process.exit(res.status ?? 1);
  }
}

function readStamp(name) {
  try {
    return fs.readFileSync(path.join(stampDir, name), "utf8").trim();
  } catch {
    return null;
  }
}

function writeStamp(name, value) {
  try {
    fs.mkdirSync(stampDir, { recursive: true });
    fs.writeFileSync(path.join(stampDir, name), value, "utf8");
  } catch {
    // A stamp we cannot write just means we rebuild next time.
  }
}

// 1. Desktop dependencies.
// `desktop` is a pnpm WORKSPACE member (pnpm-workspace.yaml) with no lockfile of
// its own, so the root `pnpm install` already provides its node_modules. Running
// `pnpm --dir desktop install` here would trigger a workspace-wide reconcile that
// asks to delete the modules directory, which is why it is not done: verify and
// point at the right command instead.
if (!fs.existsSync(path.join(desktopDir, "node_modules"))) {
  console.error(
    "[ui:build] desktop/node_modules is missing. Run `pnpm install` at the repo root\n" +
      "           (desktop is a workspace member; do not install it separately).",
  );
  process.exit(1);
}

// 2. Renderer build.
const srcHash = computeUiInputHash(repoRoot);
const builtIndex = path.join(outDir, "index.html");
const buildFresh = !force && fs.existsSync(builtIndex) && readStamp("ui-src.hash") === srcHash;

if (buildFresh) {
  log("control UI build inputs unchanged, skipping vite build");
} else {
  log("building renderer");
  run("pnpm", ["--filter", "bitterbot-control-ui", "build"], repoRoot);
  writeStamp("ui-src.hash", srcHash);
}

// 3. Stage into dist/control-ui for the gateway to serve.
log("staging control UI");
run("node", ["--import", "tsx", path.join("scripts", "control-ui-copy.ts")], repoRoot);
