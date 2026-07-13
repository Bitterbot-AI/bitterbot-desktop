#!/usr/bin/env node
/**
 * pnpm start:all
 *
 * Production sibling of `pnpm dev:all`. Brings the whole local stack up with
 * ONE command and zero watchers:
 *
 *   - Gateway via `pnpm start gateway` (scripts/run-node.mjs) — a plain
 *     production boot, NOT tsdown --watch. run-node self-heals a missing
 *     dist/entry.js, so this works on a fresh checkout with no prior build.
 *   - Control UI via `cd desktop && pnpm dev` (Vite).
 *
 * Idempotent: probes both ports first and starts only what is not already
 * listening. So if the gateway is already running as a systemd/launchd
 * service, this starts just the Control UI — which is exactly what the
 * onboarding wizard needs after installing the service.
 *
 * `pnpm dev:all` is retained as the watch-mode alternative for people who are
 * actively editing source; this command is what an operator running a node
 * wants. Pure Node, no `concurrently` dependency. Kills what it started on
 * Ctrl+C.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ANSI colors, no dep.
const reset = "\x1b[0m";
const colors = {
  gateway: "\x1b[36m", // cyan
  ui: "\x1b[35m", // magenta
  meta: "\x1b[2m", // dim
};

const GATEWAY_PORT = Number(process.env.BITTERBOT_GATEWAY_PORT ?? "19001");
const UI_PORT = 5173;

function prefix(name, color) {
  const tag = `${color}[${name}]${reset}`;
  return (line) => `${tag} ${line}`;
}

function meta(line) {
  process.stdout.write(`${colors.meta}[start:all] ${line}${reset}\n`);
}

// Is something already listening on 127.0.0.1:port? Resolves true if a TCP
// connection succeeds, false on refusal/timeout. Used to avoid double-starting
// a service that is already up (which would just EADDRINUSE-crash the child).
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function pipePrefixed(stream, tagger) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    let i = buf.indexOf("\n");
    while (i !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.length > 0) {
        process.stdout.write(`${tagger(line)}\n`);
      }
      i = buf.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) {
      process.stdout.write(`${tagger(buf)}\n`);
    }
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
  return { name, child };
}

/**
 * Pure decision: given what's already listening and whether the gateway is
 * managed by a service, return which pieces this launcher should start. Kept
 * side-effect-free so it is unit-testable (see src/infra/start-all.test.ts).
 *
 *  - gatewayManagedElsewhere: a service owns the gateway → never start one.
 *  - gatewayUp / uiUp: that port is already listening → leave it as-is.
 */
export function planStack({ gatewayManagedElsewhere, gatewayUp, uiUp }) {
  return {
    startGateway: !gatewayManagedElsewhere && !gatewayUp,
    startUi: !uiUp,
  };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  // When a service manager already owns the gateway (the onboarding wizard sets
  // this after installing a systemd/launchd service), never start one here —
  // just bring up the Control UI.
  const gatewayManagedElsewhere = process.env.BITTERBOT_START_ALL_NO_GATEWAY === "1";

  const [gatewayUp, uiUp] = await Promise.all([portInUse(GATEWAY_PORT), portInUse(UI_PORT)]);
  const plan = planStack({ gatewayManagedElsewhere, gatewayUp, uiUp });

  const started = [];

  if (gatewayManagedElsewhere) {
    meta(`gateway is managed elsewhere (service) — not starting one here.`);
  } else if (gatewayUp) {
    meta(`gateway already listening on ${GATEWAY_PORT} — leaving it as-is.`);
  }
  if (plan.startGateway) {
    started.push(
      startChild("gateway", colors.gateway, "pnpm", ["start", "gateway"], { cwd: repoRoot }),
    );
  }

  if (!plan.startUi) {
    meta(`Control UI already listening on ${UI_PORT} — leaving it as-is.`);
  } else {
    started.push(
      startChild("ui", colors.ui, "pnpm", ["dev"], { cwd: path.join(repoRoot, "desktop") }),
    );
  }

  if (started.length === 0) {
    meta("Nothing to start — gateway and Control UI are already handled.");
    meta(`Open http://localhost:${UI_PORT}/`);
    process.exit(0);
  }

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    meta(`received ${signal}, stopping children`);
    const killSig = process.platform === "win32" ? "SIGKILL" : "SIGINT";
    for (const { child } of started) {
      try {
        child.kill(killSig);
      } catch {}
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  let exited = 0;
  for (const { name, child } of started) {
    child.on("exit", (code, signal) => {
      meta(`${name} exited (code=${code}, signal=${signal ?? "none"})`);
      exited++;
      // If one of the things we started dies, take the rest down too — start:all
      // is an all-or-nothing bring-up of the pieces it launched.
      if (!shuttingDown) {
        shutdown(`${name}-exit`);
      }
      if (exited >= started.length) {
        process.exit(code ?? 0);
      }
    });
  }
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
