/**
 * Hand-over from a setup gateway to the gateway service (PLAN-56 Phase 4).
 *
 * `bitterbot onboard` starts a plain background gateway for the browser setup
 * page. When setup then installs the gateway service, the service's gateway
 * cannot bind the port while the setup gateway holds it (it waits on the
 * gateway lock, and its service manager retries). So once setup finishes,
 * the setup gateway stops instead of restarting: `markSetupHandover` turns
 * any pending restart (a restart-sensitive config write) into an exit, and
 * `scheduleSetupHandoverExit` stops it shortly after the last reply is sent.
 * The service manager (systemd `Restart=always`, launchd `KeepAlive`) then
 * starts the supervised gateway on the freed port.
 */

let handoverPending = false;

export function markSetupHandover(): void {
  handoverPending = true;
}

export function setupHandoverPending(): boolean {
  return handoverPending;
}

/** Test seam. */
export function resetSetupHandoverForTest(): void {
  handoverPending = false;
}

/**
 * Stop this gateway gracefully (SIGTERM, the normal stop path) after
 * `delayMs`, so the setup page receives its final reply first.
 */
export function scheduleSetupHandoverExit(params?: {
  delayMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}): void {
  markSetupHandover();
  const kill = params?.kill ?? ((pid, signal) => process.kill(pid, signal));
  const timer = setTimeout(() => {
    try {
      kill(process.pid, "SIGTERM");
    } catch {
      // Already stopping.
    }
  }, params?.delayMs ?? 1500);
  timer.unref?.();
}
