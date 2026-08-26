#!/usr/bin/env node
/**
 * pnpm start:all
 *
 * Since PLAN-39 Phase 4 the gateway serves the Control UI itself at
 * http://127.0.0.1:19001/, so "the whole stack" is one process and this is a
 * thin, idempotent alias of `pnpm start gateway`, kept for muscle memory:
 *
 *   - probes the port first and starts nothing if a gateway is already up
 *     (a second boot would just EADDRINUSE-crash);
 *   - defers entirely to a service manager when one owns the gateway
 *     (BITTERBOT_START_ALL_NO_GATEWAY=1, set by the onboarding wizard after
 *     installing a systemd/launchd service).
 *
 * The Vite dev server (5173) is a DEVELOPMENT tool now — `pnpm dev:all` — and
 * is deliberately not started here. The respawn machinery this script used to
 * carry existed only because that separate UI process could not pick up an
 * applied update; served-from-disk assets made all of it unnecessary.
 */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const reset = "\x1b[0m";
const dim = "\x1b[2m";

const GATEWAY_PORT = Number(process.env.BITTERBOT_GATEWAY_PORT ?? "19001");

function meta(line) {
  process.stdout.write(`${dim}[start:all] ${line}${reset}\n`);
}

// Is something already listening on 127.0.0.1:port?
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

/**
 * Pure decision, unit-tested in src/infra/start-all.test.ts: start a gateway
 * only when nothing else owns one and none is already listening.
 */
export function planStack({ gatewayManagedElsewhere, gatewayUp }) {
  return { startGateway: !gatewayManagedElsewhere && !gatewayUp };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const gatewayManagedElsewhere = process.env.BITTERBOT_START_ALL_NO_GATEWAY === "1";
  const gatewayUp = await portInUse(GATEWAY_PORT);
  const plan = planStack({ gatewayManagedElsewhere, gatewayUp });
  const uiUrl = `http://127.0.0.1:${GATEWAY_PORT}/`;

  if (!plan.startGateway) {
    meta(
      gatewayManagedElsewhere
        ? "gateway is managed elsewhere (service) — nothing to start."
        : `gateway already listening on ${GATEWAY_PORT} — nothing to start.`,
    );
    meta(`Control UI: ${uiUrl}`);
    process.exit(0);
  }

  meta(`starting gateway (serves the Control UI at ${uiUrl})`);
  const child = spawn("pnpm", ["start", "gateway"], {
    stdio: "inherit",
    env: process.env,
    cwd: repoRoot,
    shell: process.platform === "win32", // pnpm on Windows needs shell for the .cmd shim
  });

  const forward = (signal) => {
    try {
      child.kill(process.platform === "win32" ? "SIGKILL" : signal);
    } catch {}
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    meta(`failed to start gateway: ${String(err)}`);
    process.exit(1);
  });
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
