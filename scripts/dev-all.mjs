#!/usr/bin/env node
/**
 * pnpm dev:all
 *
 * Runs the gateway and the Control UI dev server in one terminal with
 * prefixed, color-tagged output so you can read both logs at once.
 * Kills both cleanly on Ctrl+C.
 *
 * Pure Node — no `concurrently` dependency so the devDeps surface
 * stays lean and `pnpm install` doesn't need to pull a tree.
 *
 * Equivalent to the old two-terminal setup:
 *   Terminal 1: pnpm start gateway
 *   Terminal 2: cd desktop && pnpm dev
 *
 * Pass through env vars normally — e.g. BITTERBOT_SKIP_CHANNELS=1 still works.
 */

import { spawn } from "node:child_process";
import path from "node:path";

// ANSI colors, no dep.
const reset = "\x1b[0m";
const colors = {
  gateway: "\x1b[36m", // cyan
  ui: "\x1b[35m", // magenta
  meta: "\x1b[2m", // dim
};

function prefix(name, color) {
  const tag = `${color}[${name}]${reset}`;
  return (line) => `${tag} ${line}`;
}

function pipePrefixed(stream, tagger) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let i = buf.indexOf("\n");
    while (i !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length > 0) process.stdout.write(`${tagger(line)}\n`);
      i = buf.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) process.stdout.write(`${tagger(buf)}\n`);
  });
}

function startChild(name, color, cmd, args, opts = {}) {
  const tagger = prefix(name, color);
  process.stdout.write(`${tagger(`starting: ${cmd} ${args.join(" ")}`)}\n`);
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: process.platform === "win32", // pnpm on Windows needs shell to resolve the .cmd shim
    ...opts,
  });
  pipePrefixed(child.stdout, tagger);
  pipePrefixed(child.stderr, tagger);
  return child;
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const gateway = startChild("gateway", colors.gateway, "pnpm", ["start", "gateway"], {
  cwd: repoRoot,
});

const ui = startChild("ui", colors.ui, "pnpm", ["dev"], {
  cwd: path.join(repoRoot, "desktop"),
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${colors.meta}[dev:all] received ${signal}, stopping children${reset}\n`);
  const killSig = process.platform === "win32" ? "SIGKILL" : "SIGINT";
  try {
    gateway.kill(killSig);
  } catch {}
  try {
    ui.kill(killSig);
  } catch {}
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let exited = 0;
function onExit(name) {
  return (code, signal) => {
    process.stdout.write(
      `${colors.meta}[dev:all] ${name} exited (code=${code}, signal=${signal ?? "none"})${reset}\n`,
    );
    exited++;
    // If one dies, take the other down too — dev:all is an all-or-nothing thing.
    if (!shuttingDown) shutdown(`${name}-exit`);
    if (exited >= 2) {
      process.exit(code ?? 0);
    }
  };
}

gateway.on("exit", onExit("gateway"));
ui.on("exit", onExit("ui"));
