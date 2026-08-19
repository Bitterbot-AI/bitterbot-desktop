import type { IncomingMessage, ServerResponse } from "node:http";
// Dev-server endpoint that lets the Control UI start the gateway when the
// gateway itself is down. The Vite dev server is the only process still
// listening at that point (PLAN-39 gateway-served UI is unbuilt; the Tauri
// shell has no IPC wired), so it hosts POST /__gateway/start.
//
// Security posture: the endpoint only exists on the dev server (loopback,
// :5173), requires the gateway auth token in an x-bitterbot-token header
// (custom header forces a CORS preflight, which cross-origin pages fail),
// and refuses to spawn anything when no token is configured at all.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface GatewayTarget {
  host: string;
  port: number;
}

export function parseGatewayTarget(gatewayUrl: string): GatewayTarget {
  try {
    const url = new URL(gatewayUrl);
    return {
      host: url.hostname || "127.0.0.1",
      port: url.port ? Number(url.port) : 19001,
    };
  } catch {
    return { host: "127.0.0.1", port: 19001 };
  }
}

export function probeTcp(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function tokensMatch(expected: string, provided: string): boolean {
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnGateway(repoRoot: string, logPath: string): number | undefined {
  // Same entry as `pnpm start gateway` — production config, no dev mode.
  let stdio: ("ignore" | number)[] = ["ignore", "ignore", "ignore"];
  let logFd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logFd = fs.openSync(logPath, "a");
    stdio = ["ignore", logFd, logFd];
  } catch {
    // No log file — spawn silently rather than fail the start.
  }
  try {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "run-node.mjs"), "gateway"],
      {
        cwd: repoRoot,
        detached: true,
        stdio,
      },
    );
    child.unref();
    return child.pid;
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

export interface GatewayStartHandlerOptions {
  /** Re-resolved per request so a token created after server boot works. */
  resolveToken: () => string;
  gatewayUrl: string;
  repoRoot: string;
  logPath: string;
  probe?: (host: string, port: number) => Promise<boolean>;
  spawnGateway?: (repoRoot: string, logPath: string) => number | undefined;
  isPidAlive?: (pid: number) => boolean;
}

export type GatewayStartState = "running" | "starting" | "started";

/**
 * Connect-style handler for POST /__gateway/start.
 *
 * Idempotent: if the gateway port already answers it reports "running"; if a
 * previously spawned child is still alive but not yet listening (boot can take
 * minutes) it reports "starting" instead of double-spawning. The gateway's own
 * PID lock is the backstop if a second copy does race in.
 */
export function createGatewayStartHandler(opts: GatewayStartHandlerOptions) {
  const probe = opts.probe ?? probeTcp;
  const spawnGateway = opts.spawnGateway ?? defaultSpawnGateway;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const target = parseGatewayTarget(opts.gatewayUrl);
  let lastPid: number | undefined;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const reply = (statusCode: number, body: Record<string, unknown>) => {
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method !== "POST") {
        reply(405, { ok: false, error: "method not allowed" });
        return;
      }
      const expected = opts.resolveToken();
      if (!expected) {
        reply(503, { ok: false, error: "no gateway token configured; run onboarding first" });
        return;
      }
      const header = req.headers["x-bitterbot-token"];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!provided || !tokensMatch(expected, provided)) {
        reply(403, { ok: false, error: "invalid token" });
        return;
      }

      if (await probe(target.host, target.port)) {
        reply(200, { ok: true, state: "running" satisfies GatewayStartState });
        return;
      }
      if (lastPid !== undefined && isPidAlive(lastPid)) {
        reply(200, { ok: true, state: "starting" satisfies GatewayStartState, pid: lastPid });
        return;
      }

      const pid = spawnGateway(opts.repoRoot, opts.logPath);
      if (pid === undefined) {
        reply(500, { ok: false, error: "failed to spawn gateway process" });
        return;
      }
      lastPid = pid;
      reply(200, { ok: true, state: "started" satisfies GatewayStartState, pid });
    } catch (err) {
      reply(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}
