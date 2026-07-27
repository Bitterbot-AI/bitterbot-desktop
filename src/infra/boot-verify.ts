import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

/**
 * Post-update boot-health beacon.
 *
 * A successful `update.run` rebuilds and then restarts the gateway into a
 * fresh process. That fresh boot happens AFTER the old process has exited,
 * unsupervised — so a runtime-only boot failure (a migration crash, a
 * boot-time init error the build/lint/doctor gate could not see) leaves the
 * node down with no signal about why.
 *
 * This beacon closes the visibility gap without any destructive automation:
 *   - update.run ARMS it (prevSha + a generous deadline) right before it
 *     schedules the restart.
 *   - The gateway CONFIRMS (clears) it the moment it is listening — so a
 *     healthy boot erases the beacon and nobody ever sees it.
 *   - If the fresh boot never gets that far, the beacon survives. `bitterbot
 *     doctor` reads it and, once its deadline has passed, reports a loud
 *     error with the exact sha to roll back to.
 *
 * It never rolls back on its own (that would mean an automatic `git reset
 * --hard`, a decision with real blast radius) — it makes a silently-dead
 * update loud and hands the human a one-line recovery path.
 */

const BOOT_VERIFY_FILENAME = "boot-verify.json";

/** Generous by design: a cold boot can take many minutes (channels, gmail, */
/** cron, browser). The beacon flags "boot never completed", not "boot slow". */
export const DEFAULT_BOOT_VERIFY_DEADLINE_MS = 30 * 60 * 1000;

export type BootVerifyRecord = {
  /** The sha to roll back to if the fresh boot never confirms. */
  prevSha: string | null;
  /** When the beacon was armed (epoch ms). */
  armedAt: number;
  /** After this instant an uncleared beacon is treated as a failed boot. */
  deadlineAt: number;
  /** Free-form reason for logs/UI. */
  reason?: string;
};

function beaconPath(): string {
  return path.join(resolveStateDir(), BOOT_VERIFY_FILENAME);
}

/** Arm the beacon before scheduling a post-update restart. Never throws. */
export function armBootVerify(params: {
  prevSha: string | null;
  now?: number;
  deadlineMs?: number;
  reason?: string;
}): void {
  const now = params.now ?? Date.now();
  const deadlineMs = params.deadlineMs ?? DEFAULT_BOOT_VERIFY_DEADLINE_MS;
  const record: BootVerifyRecord = {
    prevSha: params.prevSha,
    armedAt: now,
    deadlineAt: now + Math.max(60_000, deadlineMs),
    reason: params.reason,
  };
  try {
    fs.mkdirSync(path.dirname(beaconPath()), { recursive: true });
    fs.writeFileSync(beaconPath(), JSON.stringify(record, null, 2), "utf-8");
  } catch {
    // A missing beacon just means no post-update health surface; never fatal.
  }
}

/** Clear the beacon — the gateway calls this the instant it is listening. */
export function confirmBootHealthy(): void {
  try {
    fs.rmSync(beaconPath(), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Remove an armed beacon because the restart it was guarding never happened
 * (daemon not installed, restart threw). Same file removal as
 * confirmBootHealthy, distinct name so call sites read as what they mean: a
 * beacon with no boot coming would go stale and false-error 30 minutes later —
 * and, doctor errors being update-blocking, brick every subsequent update.
 */
export function disarmBootVerify(): void {
  confirmBootHealthy();
}

/** The raw beacon if one is armed, else null. */
export function readBootVerify(): BootVerifyRecord | null {
  try {
    const raw = fs.readFileSync(beaconPath(), "utf-8");
    const parsed = JSON.parse(raw) as BootVerifyRecord;
    if (parsed && typeof parsed === "object" && typeof parsed.deadlineAt === "number") {
      return parsed;
    }
  } catch {
    /* no beacon / unreadable */
  }
  return null;
}

/**
 * A beacon whose deadline has passed with no confirmation — i.e. the last
 * update restarted but the fresh gateway never came up. null when there is no
 * beacon or its deadline has not yet passed (boot may still be in progress).
 */
export function readStaleBootVerify(now: number = Date.now()): BootVerifyRecord | null {
  const record = readBootVerify();
  if (!record) return null;
  return now > record.deadlineAt ? record : null;
}
