/**
 * PLAN-57 §4.7: terminal compute jobs the agent or the owner started become
 * memory episodes, so "what did the pool compute for me last week" is
 * answerable from memory. The watcher emits one episode per terminal
 * transition it delivers; the memory manager registers the sink that turns
 * it into a searchable `episode` chunk. Internal jobs (the node's own
 * embedding batches) never become episodes.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ComputeJobSummary } from "./backend.js";
import type { ComputeJobOrigin } from "./deliveries.js";

const log = createSubsystemLogger("compute/episodes");

export const TERMINAL_JOB_STATUSES = new Set([
  "succeeded",
  "failed",
  "expired",
  "cancelled",
  "refunded",
]);

export type ComputeEpisode = {
  jobId: string;
  status: string;
  mode: string;
  scope: string | null;
  workload: string;
  items: number;
  worker: string | null;
  verification: string | null;
  error: string | null;
  /** Who started it; `internal` jobs are never emitted. */
  origin: Exclude<ComputeJobOrigin, "internal">;
  /** The session the job reports to (the agent's, or the owner's main session). */
  sessionKey: string | null;
  /**
   * Epoch ms when the gateway recorded the transition. After a gateway
   * outage this is the reconcile time, not the moment the job finished; the
   * coordinator does not report a completion time.
   */
  at: number;
};

export type ComputeEpisodeSink = (episode: ComputeEpisode) => Promise<unknown> | unknown;

let sink: ComputeEpisodeSink | null = null;

/** The memory system registers where episodes go. Null unregisters. */
export function registerComputeEpisodeSink(next: ComputeEpisodeSink | null): void {
  sink = next;
}

export function getComputeEpisodeSink(): ComputeEpisodeSink | null {
  return sink;
}

export function resetComputeEpisodesForTest(): void {
  sink = null;
}

/** Only the first clause of a coordinator error is kept: enough to recall why, never a dump. */
const ERROR_CLAUSE_MAX = 80;

export function episodeFromJob(
  job: ComputeJobSummary,
  route: { origin: Exclude<ComputeJobOrigin, "internal">; sessionKey?: string | null },
  at: number,
): ComputeEpisode {
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    scope: job.scope ?? null,
    workload: job.workload,
    items: job.items,
    worker: job.worker ?? null,
    verification: job.verification ?? null,
    error: job.error ? firstClause(job.error) : null,
    origin: route.origin,
    sessionKey: route.sessionKey ?? null,
    at,
  };
}

function firstClause(text: string): string {
  const clause = text.split(/[.;\n]/)[0] ?? text;
  return clause.trim().slice(0, ERROR_CLAUSE_MAX);
}

/** One sentence a person or the agent can read back later. */
export function formatComputeEpisode(ep: ComputeEpisode): string {
  const scope = ep.scope ? ` in ${ep.scope}` : "";
  const where = ep.worker ? ` on worker ${ep.worker}` : "";
  const by = ep.origin === "agent" ? "the agent" : "the owner";
  const ver = ep.verification ? ` Verification: ${ep.verification}.` : "";
  const err = ep.error ? ` Error: ${ep.error}.` : "";
  const when = new Date(ep.at).toISOString().slice(0, 16).replace("T", " ");
  return `Compute job ${ep.jobId} (${ep.workload} x${ep.items}, ${ep.mode}${scope}${where}) ${ep.status}, recorded ${when} UTC; started by ${by}.${ver}${err}`;
}

/**
 * Hand an episode to the sink without waiting on it. The watcher must never
 * stall or fail a delivery because memory was slow or absent.
 */
export function emitComputeEpisode(ep: ComputeEpisode): void {
  if (!sink || !TERMINAL_JOB_STATUSES.has(ep.status)) {
    return;
  }
  try {
    const out = sink(ep);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).catch((err) => {
        log.debug(`compute episode sink failed job=${ep.jobId}: ${String(err)}`);
      });
    }
  } catch (err) {
    log.debug(`compute episode sink threw job=${ep.jobId}: ${String(err)}`);
  }
}
