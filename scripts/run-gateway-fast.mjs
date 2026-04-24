#!/usr/bin/env node
/**
 * Fast-path gateway launcher for WSL/9P workspaces.
 *
 * rsyncs dist/ + node_modules/ from the repo (on /mnt/d, served over 9P)
 * to ~/.bitterbot-stage/ (native ext4) and execs Node there. Boot-time
 * file reads no longer cross the 9P boundary. Source of truth stays on
 * the repo; staging is a read-only runtime mirror resynced on each launch.
 *
 * Also sets NODE_COMPILE_CACHE so V8 bytecode is cached across boots.
 *
 * Usage: node scripts/run-gateway-fast.mjs [gateway args...]
 *   e.g. node scripts/run-gateway-fast.mjs gateway
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const STAGE_DIR = path.join(homedir(), ".bitterbot-stage");
const CACHE_DIR = path.join(homedir(), ".cache", "node-compile");

mkdirSync(STAGE_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

function rsync(src, dest, extraArgs = []) {
  execFileSync(
    "rsync",
    [
      "-a",
      "--inplace",
      "--no-whole-file",
      "--delete",
      ...extraArgs,
      src.endsWith("/") ? src : src + "/",
      dest.endsWith("/") ? dest : dest + "/",
    ],
    { stdio: "inherit" },
  );
}

console.log("[stage] syncing to", STAGE_DIR);
const t0 = Date.now();
rsync(path.join(REPO_ROOT, "dist"), path.join(STAGE_DIR, "dist"), [
  "--exclude",
  ".cache",
  "--exclude",
  ".turbo",
]);
rsync(path.join(REPO_ROOT, "node_modules"), path.join(STAGE_DIR, "node_modules"));
// package.json is read at runtime by tooling (e.g. build-info, version
// lookups). Copy it verbatim; other root files are added on demand.
execFileSync("cp", [path.join(REPO_ROOT, "package.json"), path.join(STAGE_DIR, "package.json")]);
console.log(`[stage] synced in ${Math.round((Date.now() - t0) / 1000)}s`);

const entry = path.join(STAGE_DIR, "dist", "entry.js");
if (!existsSync(entry)) {
  console.error("[stage] missing", entry, "— run `pnpm build` first");
  process.exit(1);
}

// Default to the gateway subcommand; callers can override with argv.
const args = process.argv.slice(2);
if (args.length === 0) {
  args.push("gateway");
}

const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", entry, ...args], {
  cwd: STAGE_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_COMPILE_CACHE: CACHE_DIR,
    // Skip the respawn trampoline in src/entry.ts — we already passed
    // --disable-warning=ExperimentalWarning above, so the child doesn't
    // need to relaunch itself.
    BITTERBOT_NODE_OPTIONS_READY: "1",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
