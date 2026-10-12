/**
 * Is a gateway still running against this state? (PLAN-56 Phase 3b)
 *
 * A rollback that restores a memory database renames the live file away,
 * so it must POSITIVELY confirm that no gateway holds the state first: an
 * RPC that does not answer (remote mode, auth failure, a slow or hung
 * gateway) proves nothing. A gateway counts as gone only when all of these
 * hold:
 *
 *   - the gateway lock (gateway-lock.ts) is absent or its owner has exited;
 *   - nothing accepts connections on the configured port on 127.0.0.1;
 *   - when the caller launched the gateway itself (the respawn watchdog),
 *     no process is left in that launch's process group.
 *
 * Anything that cannot be checked counts as "still running".
 */

import net from "node:net";
import { readGatewayLockOwner } from "./gateway-lock.js";

export type PortProbe = "open" | "closed" | "unknown";

/** Connect to 127.0.0.1:`port`: "closed" only on ECONNREFUSED. */
export function probeLoopbackPort(port: number, timeoutMs = 1_500): Promise<PortProbe> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (result: PortProbe) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(timeoutMs, () => done("unknown"));
    socket.once("connect", () => done("open"));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      done(err.code === "ECONNREFUSED" ? "closed" : "unknown"),
    );
  });
}

/** Does process group `pgid` still have a live member? */
export function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 1) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type GatewayPresence = { gone: boolean; detail: string };

export type GatewayPresenceDeps = {
  lockOwner?: typeof readGatewayLockOwner;
  probePort?: (port: number) => Promise<PortProbe>;
  groupAlive?: (pgid: number) => boolean;
};

/** One look: is every sign of a running gateway gone? */
export async function checkGatewayGone(
  params: {
    /** The configured gateway port (null: skip the port probe). */
    port: number | null;
    /** Process group of a gateway this process launched (respawn watchdog). */
    pgid?: number | null;
    env?: NodeJS.ProcessEnv;
  } & GatewayPresenceDeps,
): Promise<GatewayPresence> {
  const running: string[] = [];
  const lock = await (params.lockOwner ?? readGatewayLockOwner)({ env: params.env }).catch(() => ({
    status: "unknown" as const,
    pid: null,
    lockPath: "",
  }));
  if (lock.status === "alive" || lock.status === "unknown") {
    running.push(
      lock.pid ? `the gateway lock is held by pid ${lock.pid}` : "the gateway lock cannot be read",
    );
  }
  if (params.port) {
    const probe = await (params.probePort ?? probeLoopbackPort)(params.port);
    if (probe === "open") {
      running.push(`port ${params.port} on 127.0.0.1 accepts connections`);
    } else if (probe === "unknown") {
      running.push(`port ${params.port} on 127.0.0.1 could not be checked`);
    }
  }
  if (params.pgid && (params.groupAlive ?? processGroupAlive)(params.pgid)) {
    running.push(`process group ${params.pgid} of the launched gateway is still alive`);
  }
  return running.length === 0
    ? { gone: true, detail: "no gateway lock, nothing on the gateway port" }
    : { gone: false, detail: running.join("; ") };
}

/**
 * Poll checkGatewayGone until it confirms `confirmations` times in a row
 * (default 2: a supervisor restarting a crashing gateway can leave a short
 * gap with no lock and a closed port), or `timeoutMs` passes (last result).
 */
export async function waitForGatewayGone(
  params: Parameters<typeof checkGatewayGone>[0] & {
    timeoutMs?: number;
    intervalMs?: number;
    confirmations?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<GatewayPresence> {
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = now() + (params.timeoutMs ?? 30_000);
  const needed = Math.max(1, params.confirmations ?? 2);
  let streak = 0;
  for (;;) {
    const res = await checkGatewayGone(params);
    streak = res.gone ? streak + 1 : 0;
    if (streak >= needed) {
      return res;
    }
    if (now() >= until) {
      return res.gone
        ? { gone: false, detail: "the gateway was not gone in consecutive checks" }
        : res;
    }
    await sleep(params.intervalMs ?? 1_000);
  }
}
