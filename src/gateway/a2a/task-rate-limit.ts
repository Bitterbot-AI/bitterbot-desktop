/**
 * A2A task-creation rate limit.
 *
 * `message/send` and `message/stream` each SPAWN a sub-agent session. On a
 * publicly-reachable node (the Forage tunnel, an exposed gateway) that is a
 * resource-drain surface: a burst of bare "hi" messages from a peer would
 * spin up one agent run apiece. The x402 payment gate rate-limits only the
 * *payment* path and only when payments are enabled, so a node without
 * payments had NO ceiling on inbound task spawns.
 *
 * This is a fixed-window per-client counter (same shape as the payment
 * limiter) applied to the task-creating verbs before the task is created,
 * regardless of whether payments are on. It is deliberately generous — real
 * peers and local automation stay well under it; only floods trip it.
 *
 * Keying: the resolved client IP. Behind a trusted reverse proxy that
 * forwards the peer address this limits per-peer; when everything arrives
 * as one tunnel address it collapses to a single bucket, which still caps
 * the aggregate spawn rate from that ingress. Circle and Forage verbs have
 * their own admission controls and do not pass through here.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("a2a/task-rate-limit");

/** Default ceiling: task spawns per client per minute. */
export const DEFAULT_MAX_TASKS_PER_MINUTE = 12;
const WINDOW_MS = 60_000;

const tracker = new Map<string, { count: number; windowStart: number }>();

/** Reset the in-memory window (tests). */
export function resetTaskRateLimit(): void {
  tracker.clear();
}

/**
 * Record one task-creation attempt for `clientKey` and report whether it
 * exceeds `maxPerMinute`. A non-positive limit disables the check (returns
 * false always) so operators can opt out explicitly.
 */
export function isTaskCreationRateLimited(
  clientKey: string,
  maxPerMinute: number = DEFAULT_MAX_TASKS_PER_MINUTE,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(maxPerMinute) || maxPerMinute <= 0) {
    return false;
  }
  const key = clientKey || "unknown";
  const entry = tracker.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    tracker.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  if (entry.count > maxPerMinute) {
    log.warn(`A2A task rate limit exceeded for ${key} (${entry.count}/${maxPerMinute} per min)`);
    return true;
  }
  return false;
}
