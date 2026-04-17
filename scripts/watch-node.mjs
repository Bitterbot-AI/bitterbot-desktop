#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const env = { ...process.env };
const cwd = process.cwd();
const compiler = "tsdown";
const watchSession = `${Date.now()}-${process.pid}`;
env.BITTERBOT_WATCH_MODE = "1";
env.BITTERBOT_WATCH_SESSION = watchSession;
if (args.length > 0) {
  env.BITTERBOT_WATCH_COMMAND = args.join(" ");
}

const initialBuild = spawnSync("pnpm", ["exec", compiler], {
  cwd,
  env,
  stdio: "inherit",
});

if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

// --no-clean is critical here: in watch mode, tsdown would otherwise wipe
// dist/ on every rebuild, which races with node --watch reloading. The running
// CLI throws ENOENT on hashed chunks (e.g. dist/genome-parser-XXXX.js) that
// got cleaned mid-execution. The initial spawnSync build above already did
// a full clean, so skipping cleans on incremental rebuilds is safe.
const compilerProcess = spawn("pnpm", ["exec", compiler, "--watch", "--no-clean"], {
  cwd,
  env,
  stdio: "inherit",
});

const nodeProcess = spawn(process.execPath, ["--watch", "bitterbot.mjs", ...args], {
  cwd,
  env,
  stdio: "inherit",
});

let exiting = false;

function cleanup(code = 0) {
  if (exiting) {
    return;
  }
  exiting = true;
  nodeProcess.kill("SIGTERM");
  compilerProcess.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

compilerProcess.on("exit", (code) => {
  if (exiting) {
    return;
  }
  cleanup(code ?? 1);
});

nodeProcess.on("exit", (code, signal) => {
  if (signal || exiting) {
    return;
  }
  cleanup(code ?? 1);
});
