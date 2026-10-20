/**
 * Runtime repeat-call guard (2026-09-05 harness review, B6).
 *
 * The offline signals already detect repeated tool blocks after the fact;
 * nothing stopped the loop while it was happening, and `tool-cache.ts`
 * makes an identical failing call cheap enough to repeat indefinitely. This
 * guard counts identical (tool, args) calls per session, and once the same
 * call has FAILED `REPEAT_BLOCK_AFTER` times it refuses the next identical
 * attempt with a message that names the failure and asks for a different
 * strategy. The refusal surfaces as an error tool result the model reads,
 * and lands in the journal so the labeler can tag the run
 * `repeated-unsuccessful-retry` instead of "clean end".
 *
 * Scope is the session key (one active run per session under the write
 * lock); the counter resets on every agent start.
 */

import crypto from "node:crypto";

export const REPEAT_BLOCK_AFTER = 3;
const MAX_TRACKED_SCOPES = 500;
const MAX_TRACKED_CALLS_PER_SCOPE = 200;

type CallRecord = { attempts: number; failures: number; lastError: string | null };

const byScope = new Map<string, Map<string, CallRecord>>();

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .toSorted()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function toolCallFingerprint(toolName: string, args: unknown): string {
  return crypto
    .createHash("sha1")
    .update(`${toolName}\n${canonical(args)}`)
    .digest("hex");
}

function scopeMap(scope: string): Map<string, CallRecord> {
  let m = byScope.get(scope);
  if (!m) {
    m = new Map();
    byScope.set(scope, m);
    if (byScope.size > MAX_TRACKED_SCOPES) {
      const oldest = byScope.keys().next().value;
      if (oldest !== undefined) {
        byScope.delete(oldest);
      }
    }
  }
  return m;
}

/** Called on agent start so a new run never inherits an old run's strikes. */
export function resetRepeatGuard(scope: string | undefined): void {
  if (scope) {
    byScope.delete(scope);
  }
}

export function resetRepeatGuardForTest(): void {
  byScope.clear();
}

/**
 * Record the outcome of a completed call. `error` is the extracted error
 * message when the call failed (thrown or body-level), undefined otherwise.
 */
export function recordToolCallOutcome(params: {
  scope: string | undefined;
  toolName: string;
  args: unknown;
  error: string | undefined;
}): void {
  if (!params.scope) {
    return;
  }
  const m = scopeMap(params.scope);
  const fp = toolCallFingerprint(params.toolName, params.args);
  const rec = m.get(fp) ?? { attempts: 0, failures: 0, lastError: null };
  rec.attempts += 1;
  if (params.error !== undefined) {
    rec.failures += 1;
    rec.lastError = params.error.slice(0, 200);
  } else {
    // A success clears the streak: the environment changed, or the call
    // was legitimately retried until it worked.
    rec.failures = 0;
    rec.lastError = null;
  }
  m.set(fp, rec);
  if (m.size > MAX_TRACKED_CALLS_PER_SCOPE) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) {
      m.delete(oldest);
    }
  }
}

/**
 * Decide whether an about-to-run call is the (REPEAT_BLOCK_AFTER+1)th
 * identical failing attempt. Pure read; never mutates.
 */
export function checkRepeatedCall(params: {
  scope: string | undefined;
  toolName: string;
  args: unknown;
}): { blocked: false } | { blocked: true; reason: string; failures: number } {
  if (!params.scope) {
    return { blocked: false };
  }
  const rec = byScope.get(params.scope)?.get(toolCallFingerprint(params.toolName, params.args));
  if (!rec || rec.failures < REPEAT_BLOCK_AFTER) {
    return { blocked: false };
  }
  return {
    blocked: true,
    failures: rec.failures,
    reason:
      `REPEATED-CALL: ${params.toolName} was called ${rec.failures} times with identical arguments and failed every time` +
      `${rec.lastError ? ` (last error: ${rec.lastError})` : ""}. ` +
      "Retrying the same call again will not succeed. Change the arguments, use a different tool, " +
      "or explain the blocker to the user instead of retrying.",
  };
}
