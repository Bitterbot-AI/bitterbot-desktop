/**
 * Fail-closed pre-turn decision seam (PLAN-22 Phase 0, P0.1).
 *
 * The gateway `agent` handler acks `{status:"accepted"}` to the client and
 * then fire-and-forgets the run via `agentCommand`. This module provides the
 * one safe place to influence that run *after* the ack and *before* the
 * dispatch: a registered decider may augment the message and the system
 * prompt (PLAN-22 Phase 3 registers the complexity gate here).
 *
 * The wrapper is the structural "cannot break the gateway" guarantee:
 *   - No decider registered -> returns the payload unchanged.
 *   - The decider throws -> returns the original payload.
 *   - The decider exceeds the timeout -> returns the original payload.
 *   - The decider returns a malformed payload -> returns the original.
 * In every failure mode the run proceeds exactly as it would have without
 * the seam. The decider can only ever augment; it can never block or fail
 * the turn, and (because it runs after the ack) it cannot delay the ack.
 */

export interface PreTurnPayload {
  /** The user message that will be dispatched to the agent run. */
  message: string;
  /** Extra system prompt threaded into the run (e.g. a goal first-slice). */
  extraSystemPrompt?: string;
}

export interface PreTurnContext {
  sessionKey: string | null;
  agentId: string;
  runId: string;
  channel: string;
}

export type PreTurnDecider = (
  payload: PreTurnPayload,
  ctx: PreTurnContext,
) => Promise<PreTurnPayload> | PreTurnPayload;

/** Hard timeout on the decider so it can never stall the dispatch. */
export const DEFAULT_PRE_TURN_TIMEOUT_MS = 800;

let decider: PreTurnDecider | null = null;

/** Register (or clear, with null) the pre-turn decider. Last writer wins. */
export function registerPreTurnDecider(fn: PreTurnDecider | null): void {
  decider = fn;
}

/** Test/introspection helper. */
export function hasPreTurnDecider(): boolean {
  return decider != null;
}

function isValidPayload(value: unknown): value is PreTurnPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pre-turn decider timed out")), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Apply the registered pre-turn decision. Always resolves; never rejects.
 * Returns the (possibly augmented) payload, or the original on any failure.
 */
export async function applyPreTurnDecision(
  payload: PreTurnPayload,
  ctx: PreTurnContext,
  opts: { timeoutMs?: number } = {},
): Promise<PreTurnPayload> {
  const fn = decider;
  if (!fn) {
    return payload;
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PRE_TURN_TIMEOUT_MS;
  try {
    const result = await withTimeout(Promise.resolve(fn(payload, ctx)), timeoutMs);
    return isValidPayload(result) ? result : payload;
  } catch {
    // Fail-closed: any throw or timeout degrades to the unmodified payload.
    return payload;
  }
}
