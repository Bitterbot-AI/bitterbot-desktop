/**
 * Gateway Bridge — imports and starts the Bitterbot gateway server in-process
 * within Electron's main (Node.js) process.
 *
 * If a healthy Bitterbot gateway is already running on the target port
 * (e.g. from a previous session that didn't shut down cleanly, or from
 * `bitterbot gateway start` on the CLI), we reuse it instead of crashing.
 */

// Dynamic import because the gateway module is ESM and has heavy dependencies.
// We load it lazily so Electron's window can appear quickly.

let gatewayHandle: { close: () => Promise<void> } | null = null;
let port = 19001;
let reusingExternalGateway = false;

export function getGatewayPort(): number {
  return port;
}

/**
 * Returns true when the bridge connected to a pre-existing gateway rather
 * than starting one in-process.  `stopGateway()` is a no-op in that case.
 */
export function isReusingExternalGateway(): boolean {
  return reusingExternalGateway;
}

export async function startGateway(
  requestedPort = 19001,
  opts?: { authToken?: string },
): Promise<void> {
  port = requestedPort;

  // Set environment hints before importing gateway code
  process.env.BITTERBOT_GATEWAY_PORT = String(port);

  // Import the gateway entry point from the parent package.
  // The path is relative: desktop/ is a sibling of src/ in the monorepo.
  const { startGatewayServer } = await import(
    "../../src/gateway/server.impl.js"
  );

  try {
    gatewayHandle = await startGatewayServer(port, {
      bind: "loopback",
    });
  } catch (err) {
    // If the port is already in use, check whether a healthy Bitterbot
    // gateway is listening there and reuse it instead of failing.
    const isPortConflict =
      err instanceof Error &&
      (err.name === "GatewayLockError" ||
        err.message.includes("EADDRINUSE") ||
        err.message.includes("already listening"));

    if (isPortConflict) {
      console.log(`[bitterbot] Port ${port} in use — probing for existing gateway`);
      const probeResult = await probeExistingGateway(port, opts?.authToken);
      if (probeResult.alive) {
        console.log(`[bitterbot] Healthy gateway found on port ${port} — reusing it`);
        reusingExternalGateway = true;
        return;
      }
      console.warn(
        `[bitterbot] Port ${port} is occupied but not by a healthy gateway (${probeResult.reason}). ` +
        `Attempting to free the port.`,
      );
      const freed = await tryFreePort(port);
      if (freed) {
        console.log(`[bitterbot] Port ${port} freed — retrying gateway start`);
        gatewayHandle = await startGatewayServer(port, { bind: "loopback" });
        return;
      }
    }

    throw err;
  }
}

/**
 * Probe a port to see if a healthy Bitterbot gateway is already running there.
 * Uses the same WebSocket probe the CLI uses for `bitterbot gateway status`.
 */
async function probeExistingGateway(
  gatewayPort: number,
  authToken?: string,
): Promise<{ alive: boolean; reason: string }> {
  try {
    const { probeGateway } = await import("../../src/gateway/probe.js");
    const result = await probeGateway({
      url: `ws://127.0.0.1:${gatewayPort}`,
      auth: authToken ? { token: authToken } : undefined,
      timeoutMs: 3000,
    });
    if (result.ok) {
      return { alive: true, reason: "healthy" };
    }
    return { alive: false, reason: result.error ?? result.close?.reason ?? "probe returned not-ok" };
  } catch (err) {
    return { alive: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Attempt to kill whatever is on the port (cross-platform).
 * Returns true if the port becomes free within a few seconds.
 */
async function tryFreePort(targetPort: number): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "win32") {
      const output = execSync(
        `netstat -ano | findstr "LISTENING" | findstr ":${targetPort} "`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      const pids = new Set<string>();
      for (const line of output.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 });
          console.log(`[bitterbot] Killed PID ${pid} on port ${targetPort}`);
        } catch {}
      }
    } else {
      const output = execSync(
        `lsof -nP -iTCP:${targetPort} -sTCP:LISTEN -t`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      for (const pid of output.split(/\s+/)) {
        if (pid && /^\d+$/.test(pid)) {
          try { process.kill(Number(pid), "SIGTERM"); } catch {}
        }
      }
    }
  } catch {
    return false;
  }
  // Wait for port to free
  const deadline = Date.now() + 3000;
  const { createConnection } = await import("node:net");
  while (Date.now() < deadline) {
    const inUse = await new Promise<boolean>((resolve) => {
      const s = createConnection({ host: "127.0.0.1", port: targetPort });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
      s.setTimeout(500, () => { s.destroy(); resolve(false); });
    });
    if (!inUse) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function stopGateway(): Promise<void> {
  if (gatewayHandle) {
    await gatewayHandle.close();
    gatewayHandle = null;
  }
  // If we're reusing an external gateway, don't touch it — we didn't start it.
}
