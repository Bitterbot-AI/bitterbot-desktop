/**
 * PLAN-46 Phase 4: serialize memory maintenance jobs.
 *
 * The manager runs several heavy maintenance jobs on independent timers
 * (consolidation, dream, digest, health sweep, trending sweep), all against one
 * synchronous SQLite connection on one event loop. Nothing coordinated them, so
 * two could interleave writes to the same chunk (the 2026-09-07 audit found
 * dream and consolidation both mutating chunk lifecycle on different cadences)
 * and two could pile onto the loop at once, compounding stalls.
 *
 * This mutex runs maintenance jobs one at a time, FIFO. It is NOT re-entrant: a
 * job must not acquire it again from within itself (jobs are wrapped at their
 * timer call sites, which never nest). A per-job budget logs a warning when a
 * job overruns, so a slow job is visible without failing.
 *
 * Invariant I4 (PLAN-46 §3): at most one maintenance job holds the DB at a time.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/maintenance");

export class MaintenanceMutex {
  private tail: Promise<void> = Promise.resolve();
  private runningLabel: string | null = null;

  /** The label of the job currently holding the mutex, or null. */
  get running(): string | null {
    return this.runningLabel;
  }

  /**
   * Run `fn` after every previously-queued job has finished. Serializes all
   * callers. `budgetMs` (optional) logs a warning if the job overruns.
   */
  async run<T>(label: string, fn: () => Promise<T>, budgetMs?: number): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prior;
    if (this.runningLabel) {
      log.debug(`maintenance ${label} waited behind ${this.runningLabel}`);
    }
    this.runningLabel = label;
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const dur = Date.now() - start;
      if (budgetMs && dur > budgetMs) {
        log.warn(`maintenance ${label} ran ${dur}ms (budget ${budgetMs}ms)`);
      }
      this.runningLabel = null;
      release();
    }
  }
}
