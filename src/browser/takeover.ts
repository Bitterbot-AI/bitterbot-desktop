/**
 * Who is driving the browser: the agent, or a person in the Control UI's live
 * view (PLAN-53 A3).
 *
 * While a person has control, the agent's page-driving requests wait instead of
 * fighting them for the mouse. Reads (snapshot, screenshot, tab list) are never
 * held, so the agent can still see what the person is doing.
 *
 * Control cannot be kept by accident: it ends when the person hands back, when
 * their live view goes away, or after a stretch with no input from them.
 */

export type BrowserControl = {
  profile: string;
  /** Gateway connection id of the viewer who took control. */
  controller: string;
  since: number;
  lastInputAt: number;
};

/** A person who stops interacting hands control back to the agent. */
export const TAKEOVER_IDLE_MS = 5 * 60_000;

let current: BrowserControl | null = null;
const waiters = new Set<() => void>();

const wake = () => {
  for (const resolve of waiters) {
    resolve();
  }
  waiters.clear();
};

export function takeBrowserControl(profile: string, controller: string, now = Date.now()): void {
  current = { profile, controller, since: now, lastInputAt: now };
}

/** Returns true if there was a takeover to end. */
export function releaseBrowserControl(): boolean {
  if (!current) {
    return false;
  }
  current = null;
  wake();
  return true;
}

/** The person did something: push the idle deadline out. */
export function touchBrowserControl(now = Date.now()): void {
  if (current) {
    current.lastInputAt = now;
  }
}

export function getBrowserControl(now = Date.now()): BrowserControl | null {
  if (current && now - current.lastInputAt >= TAKEOVER_IDLE_MS) {
    releaseBrowserControl();
  }
  return current;
}

export function isUserInControl(profile: string, now = Date.now()): boolean {
  const control = getBrowserControl(now);
  // Explicit null check: with nobody in control, `undefined === profile` would
  // be true for a caller that has no profile name, and hold the agent forever.
  return control !== null && control.profile === profile;
}

/**
 * Wait for the agent to get the browser back. Resolves `true` if a person
 * still has control when the wait runs out.
 */
export async function waitForAgentControl(profile: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isUserInControl(profile)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return true;
    }
    await new Promise<void>((resolve) => {
      // Wake on release, and re-check periodically so the idle rule applies
      // even when nothing else calls in.
      const timer = setTimeout(done, Math.min(remaining, 1_000));
      function done() {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });
  }
  return false;
}

/** Test seam: forget any takeover and release anyone waiting on it. */
export function resetBrowserControlForTest(): void {
  current = null;
  wake();
}
