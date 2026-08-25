#!/usr/bin/env node
/**
 * PLAN-39 Phase 1: build the Control UI and stage it for the gateway.
 *
 * `pnpm ui:build` deliberately reuses the name the update flow's progress labels
 * already expect (src/cli/update-cli/progress.ts:24-26), which have been emitted
 * by nothing since the original design was abandoned.
 *
 * Both expensive steps are content-hash gated, because this runs inside
 * `update.run` where every second is time the node is not serving:
 *   1. `pnpm --dir desktop install` is skipped when the desktop lockfile is
 *      unchanged and desktop/node_modules exists. A frozen-lockfile install that
 *      changes nothing still costs real time, badly so on network filesystems.
 *   2. `vite build` is skipped when no renderer source file has changed since the
 *      last successful build.
 * Pass --force to run both regardless.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(repoRoot, "desktop");
const rendererDir = path.join(desktopDir, "renderer");
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

/** Stable hash of every file under `dir`, ignoring build output and deps. */
function hashTree(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name === "dist-renderer" || e.name.startsWith(".")) {
        continue;
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        hash.update(path.relative(dir, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
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
const lockfile = ["pnpm-lock.yaml", "package-lock.json"]
  .map((f) => path.join(desktopDir, f))
  .find((f) => fs.existsSync(f));
const lockHash = lockfile
  ? createHash("sha256").update(fs.readFileSync(lockfile)).digest("hex")
  : "no-lockfile";
const depsFresh =
  !force &&
  fs.existsSync(path.join(desktopDir, "node_modules")) &&
  readStamp("ui-deps.hash") === lockHash;

if (depsFresh) {
  log("desktop dependencies unchanged, skipping install");
} else {
  log("installing desktop dependencies");
  run("pnpm", ["--dir", "desktop", "install", "--frozen-lockfile"], repoRoot);
  writeStamp("ui-deps.hash", lockHash);
}

// 2. Renderer build.
const srcHash = hashTree(rendererDir);
const builtIndex = path.join(outDir, "index.html");
const buildFresh = !force && fs.existsSync(builtIndex) && readStamp("ui-src.hash") === srcHash;

if (buildFresh) {
  log("renderer sources unchanged, skipping vite build");
} else {
  log("building renderer");
  run("pnpm", ["--dir", "desktop", "build"], repoRoot);
  writeStamp("ui-src.hash", srcHash);
}

// 3. Stage into dist/control-ui for the gateway to serve.
log("staging control UI");
run("node", ["--import", "tsx", path.join("scripts", "control-ui-copy.ts")], repoRoot);
