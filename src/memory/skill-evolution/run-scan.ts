/**
 * PLAN-42/44: metadata-only run enumeration for the sampler and the
 * records-mode validator. Split out of traces.ts (500-line cap). Zero blob
 * inflation except `runHasTerminal`, which inflates only lifecycle rows.
 */

import type { EventJournal } from "../../infra/event-journal.js";
import { makeYieldEvery } from "../event-loop.js";

/**
 * Enumerate runs with events after `sinceSeq`, oldest-first, from METADATA
 * ONLY (zero blob inflation). Per-run counters let callers pre-filter
 * tool-less and marathon runs before any reconstruction; `maxRuns` counts
 * only TOOL-BEARING runs so heartbeat noise cannot starve the window.
 */
export interface RunSummary {
  runId: string;
  /** First seq seen for this run WITHIN the scan window (after sinceSeq). */
  firstSeq: number;
  /** Last seq seen for this run WITHIN the scan window (never past the horizon). */
  lastSeq: number;
  totalEvents: number;
  toolEvents: number;
  /**
   * Two or more lifecycle events were seen in the window. A HEURISTIC:
   * retried attempts and subagent runs emit more than one `start`, so a
   * caller that needs the truth inflates `lifecycleSeqs` (cheap: lifecycle
   * blobs are tiny) — see `runHasTerminal`.
   */
  hasTerminal: boolean;
  /** Journal seqs of this run's lifecycle rows in the window (last 8). */
  lifecycleSeqs: number[];
}

/**
 * PLAN-44 (adversarial H3): the truthful terminal check — inflate only the
 * run's lifecycle rows and look for an `end` / `error` phase. Retried
 * attempts (`start,start,...`) and subagent runs (synthetic `start`) no
 * longer read as "complete with no tools".
 */
export function runHasTerminal(journal: EventJournal, run: RunSummary): boolean {
  if (run.lifecycleSeqs.length === 0) {
    return false;
  }
  // The terminal, if any, is the run's LAST lifecycle row: one blob.
  const last = run.lifecycleSeqs.at(-1)!;
  return journal.getBySeqs([last]).some((e) => e.data.phase === "end" || e.data.phase === "error");
}

/**
 * PLAN-44 Phase 0: the scan's cursor-safety envelope. Audit finding: the
 * sampler advanced its cursor to a run's TRUE last seq (from an unbounded
 * per-run query) while the scan had stopped at a page horizon, so one run
 * that ended past the horizon dragged the cursor over every run in between
 * (98 interleaved runs in the live journal). Callers clamp to `horizonSeq`
 * and never advance past the first event of a run they did not examine.
 */
export interface RunScan {
  runs: RunSummary[];
  /** Runs left out via `skipRunIds` (still scanned; their lastSeq is window-bounded). */
  skipped: RunSummary[];
  /** Last journal seq the scan actually looked at. */
  horizonSeq: number;
  /** Smallest firstSeq among runs seen but cut by `maxRuns` (null if none). */
  deferredMinFirstSeq: number | null;
}

export async function listRunsSinceDetailed(
  journal: EventJournal,
  opts: {
    sinceSeq: number;
    maxRuns?: number;
    /**
     * Runs to leave out of the capped result (already examined / pending).
     * They are returned in `skipped` so the caller can still advance its
     * cursor over their events; the `maxRuns` cap applies to the rest.
     */
    skipRunIds?: ReadonlySet<string>;
  },
): Promise<RunScan> {
  const maxRuns = opts.maxRuns ?? 40;
  const seen = new Map<string, RunSummary & { lifecycleEvents: number }>();
  let cursor = opts.sinceSeq;
  const tick = makeYieldEvery(4);
  for (let page = 0; page < 400; page++) {
    await tick();
    const events = journal.queryMeta({ sinceSeq: cursor, limit: 1_000 });
    if (events.length === 0) {
      break;
    }
    for (const evt of events) {
      let summary = seen.get(evt.runId);
      if (!summary) {
        summary = {
          runId: evt.runId,
          firstSeq: evt.seq,
          lastSeq: evt.seq,
          totalEvents: 0,
          toolEvents: 0,
          hasTerminal: false,
          lifecycleSeqs: [],
          lifecycleEvents: 0,
        };
        seen.set(evt.runId, summary);
      }
      summary.lastSeq = evt.seq;
      summary.totalEvents += 1;
      if (evt.stream === "tool") {
        summary.toolEvents += 1;
      }
      if (evt.stream === "lifecycle") {
        summary.lifecycleEvents += 1;
        summary.hasTerminal = summary.lifecycleEvents >= 2;
        summary.lifecycleSeqs.push(evt.seq);
        if (summary.lifecycleSeqs.length > 8) {
          summary.lifecycleSeqs.shift(); // keep the LAST 8 (the terminal is last)
        }
      }
    }
    cursor = (events[events.length - 1] as { seq: number }).seq;
    const toolBearing = [...seen.values()].filter((r) => r.toolEvents > 0).length;
    if (toolBearing >= maxRuns * 2) {
      break;
    }
  }
  // Cap at maxRuns TOOL-BEARING runs; tool-less runs before the cutoff stay
  // included so callers can advance their cursor past the noise.
  const sorted = Array.from(seen.values()).toSorted((a, b) => a.lastSeq - b.lastSeq);
  const out: RunSummary[] = [];
  const skipped: RunSummary[] = [];
  let deferredMinFirstSeq: number | null = null;
  let toolBearingKept = 0;
  let cut = false;
  for (const run of sorted) {
    const { lifecycleEvents: _ignored, ...summary } = run;
    if (opts.skipRunIds?.has(run.runId)) {
      skipped.push(summary);
      continue;
    }
    if (cut) {
      deferredMinFirstSeq =
        deferredMinFirstSeq === null ? run.firstSeq : Math.min(deferredMinFirstSeq, run.firstSeq);
      continue;
    }
    if (run.toolEvents > 0) {
      if (toolBearingKept >= maxRuns) {
        cut = true;
        deferredMinFirstSeq = run.firstSeq;
        continue;
      }
      toolBearingKept += 1;
    }
    out.push(summary);
  }
  return { runs: out, skipped, horizonSeq: cursor, deferredMinFirstSeq };
}

/** Back-compat wrapper: the run list alone. Prefer listRunsSinceDetailed for cursor work. */
export async function listRunsSince(
  journal: EventJournal,
  opts: { sinceSeq: number; maxRuns?: number },
): Promise<RunSummary[]> {
  return (await listRunsSinceDetailed(journal, opts)).runs;
}
