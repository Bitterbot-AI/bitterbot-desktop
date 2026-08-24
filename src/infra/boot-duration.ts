import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Persisted wall-clock of the last successful gateway boot, used to give clients
 * an honest "back in N seconds" hint when the gateway restarts.
 *
 * Why this exists: the hint used to be a hardcoded 1500 ms. Measured on a WSL2 +
 * 9p node on 2026-08-24, a real boot was 290s (and 1537s before the plugin-sdk
 * alias fix), so the UI told users to expect a 1.5 second outage before a
 * multi-minute one. Boot time varies by two orders of magnitude across
 * filesystems, so a constant cannot be right; the previous boot is the best
 * available predictor.
 */

const FILE_NAME = "last-boot-ms.json";

/** Ignore absurd values rather than telling a client to wait a day. */
const MIN_PLAUSIBLE_MS = 100;
const MAX_PLAUSIBLE_MS = 60 * 60 * 1000;

/** Used when nothing has been recorded yet. Deliberately not 1.5s. */
export const DEFAULT_RESTART_HINT_MS = 15_000;

const filePath = (stateDir?: string): string => path.join(stateDir ?? resolveStateDir(), FILE_NAME);

/** Record a successful boot's duration. Never throws: this is telemetry, not correctness. */
export function recordBootDurationMs(ms: number, stateDir?: string): void {
  if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS || ms > MAX_PLAUSIBLE_MS) {
    return;
  }
  try {
    const target = filePath(stateDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ bootMs: Math.round(ms), at: Date.now() }), "utf8");
  } catch {
    // A read-only or missing state dir must not break booting.
  }
}

/**
 * Best estimate of how long the next boot will take, in ms.
 * Returns {@link DEFAULT_RESTART_HINT_MS} when there is no usable record.
 */
export function readLastBootDurationMs(stateDir?: string): number {
  try {
    const raw = fs.readFileSync(filePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as { bootMs?: unknown };
    const value = typeof parsed.bootMs === "number" ? parsed.bootMs : Number.NaN;
    if (Number.isFinite(value) && value >= MIN_PLAUSIBLE_MS && value <= MAX_PLAUSIBLE_MS) {
      return Math.round(value);
    }
  } catch {
    // No record yet, unreadable, or malformed: fall through to the default.
  }
  return DEFAULT_RESTART_HINT_MS;
}
