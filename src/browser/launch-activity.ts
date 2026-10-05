/**
 * Whether a browser launch is under way, or only just finished.
 *
 * A cold start can outlast the caller's timeout (seen on 2026-10-04: the
 * browser was ready 21 ms after a 15 s timeout fired). The caller then needs
 * to tell "the browser is broken" from "the browser was still starting", and
 * only the launcher knows. Kept in its own module so the request client can
 * ask without pulling in the launcher.
 */

/** A launch that settled this recently still explains a timeout. */
export const RECENT_LAUNCH_MS = 5_000;

let inProgress = 0;
let lastSettledAt: number | null = null;

/** Run a launch and record that it is happening. */
export async function trackBrowserLaunch<T>(launch: () => Promise<T>): Promise<T> {
  inProgress += 1;
  try {
    return await launch();
  } finally {
    inProgress -= 1;
    lastSettledAt = Date.now();
  }
}

/** True while a launch is running or within RECENT_LAUNCH_MS of one ending. */
export function isBrowserStarting(now = Date.now()): boolean {
  return inProgress > 0 || (lastSettledAt !== null && now - lastSettledAt < RECENT_LAUNCH_MS);
}

export function resetBrowserLaunchActivityForTest(): void {
  inProgress = 0;
  lastSettledAt = null;
}
