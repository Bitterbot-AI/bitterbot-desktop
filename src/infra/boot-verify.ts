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
 * The beacon itself never rolls back — that job belongs to the boot
 * WATCHDOG (infra/boot-watchdog.ts), a small detached process the update
 * flow spawns alongside the beacon. The division of labor:
 *   - beacon = the signal (armed pre-restart, cleared at bind, read by
 *     doctor and the watchdog)
 *   - watchdog = the actor (waits for the beacon to clear; past the
 *     deadline it performs a single guarded rollback)
 * The `rollbackAttempted` latch below is the once-only interlock between
 * them: the watchdog sets it before acting so a rollback that itself fails
 * to boot can never trigger a second rollback (infinite reset loop).
 */

const BOOT_VERIFY_FILENAME = "boot-verify.json";
const ROLLBACK_RECORD_FILENAME = "rollback-performed.json";

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
  /**
   * Once-only rollback interlock: the watchdog sets this BEFORE acting. A
   * rolled-back build that also fails to boot must go loud, never trigger a
   * second reset.
   */
  rollbackAttempted?: boolean;
};

/** Written by the watchdog after it performs a rollback; read by doctor. */
export type RollbackRecord = {
  /** The sha of the build that failed to boot (rolled back FROM). */
  fromSha: string | null;
  /** The sha restored (rolled back TO). */
  toSha: string;
  at: number;
  /** Human-readable step outcomes for doctor to show. */
  detail: string;
  /** True when reset+install+build all succeeded. */
  ok: boolean;
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
  // A healthy bind also resolves a FAILED rollback attempt: the human (or the
  // supervisor) got a gateway up, which is exactly what the error demanded.
  // Without this, the error-level record blocks the update gate forever while
  // clearRollbackRecord() sits behind a successful update that can never
  // happen — a circular brick. Successful-rollback records (ok: true) stay:
  // they are warn-level, never block, and the next clean update clears them.
  try {
    const record = readRollbackRecord();
    if (record && !record.ok) {
      clearRollbackRecord();
    }
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

/**
 * Atomically claim the once-only rollback slot for the CURRENT beacon.
 * Returns the beacon record when the claim succeeded (this caller may roll
 * back), or null when there is no beacon, it belongs to a different arming
 * (armedAt mismatch — a newer update owns the boot), or a rollback was
 * already attempted. Crash-safe direction: the latch is persisted BEFORE the
 * caller acts, so a rollback interrupted mid-way still never repeats.
 */
export function claimRollbackAttempt(expectedArmedAt: number): BootVerifyRecord | null {
  const record = readBootVerify();
  if (!record) return null;
  if (record.armedAt !== expectedArmedAt) return null;
  if (record.rollbackAttempted) return null;
  const next: BootVerifyRecord = { ...record, rollbackAttempted: true };
  try {
    // Open "r+" (MUST NOT create): if the gateway bound and deleted the
    // beacon between our read and this write, a plain writeFileSync would
    // RESURRECT it latched and the watchdog would reset a healthy node.
    // r+ throws ENOENT on a deleted beacon → claim refused.
    const fd = fs.openSync(beaconPath(), "r+");
    try {
      const body = JSON.stringify(next, null, 2);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, body, 0, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // cannot persist the latch → do NOT act
  }
  return next;
}

function rollbackRecordPath(): string {
  return path.join(resolveStateDir(), ROLLBACK_RECORD_FILENAME);
}

/** Persist the rollback outcome for doctor to surface. Never throws. */
export function writeRollbackRecord(record: RollbackRecord): void {
  try {
    fs.mkdirSync(path.dirname(rollbackRecordPath()), { recursive: true });
    fs.writeFileSync(rollbackRecordPath(), JSON.stringify(record, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}

export function readRollbackRecord(): RollbackRecord | null {
  try {
    const raw = fs.readFileSync(rollbackRecordPath(), "utf-8");
    const parsed = JSON.parse(raw) as RollbackRecord;
    if (parsed && typeof parsed === "object" && typeof parsed.toSha === "string") {
      return parsed;
    }
  } catch {
    /* no record */
  }
  return null;
}

/**
 * Clear the rollback record — called when a LATER update applies cleanly
 * (the human has moved past the bad build) or by explicit operator action.
 */
export function clearRollbackRecord(): void {
  try {
    fs.rmSync(rollbackRecordPath(), { force: true });
  } catch {
    /* ignore */
  }
}
