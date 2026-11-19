/**
 * PLAN-62: what a paired phone's socket is allowed to hear.
 *
 * Other operator connections get every unguarded broadcast. A phone gets an
 * explicit allowlist instead: its approvals queue, owner notices, keepalive,
 * and chat/tool activity only for conversations it may use
 * (phone-policy.ts isPhoneSessionAllowed). Tool activity is cut down to what
 * the phone UI shows ("Using web search"): no arguments, no results.
 */

import type { Snapshot } from "../protocol/index.js";
import { isPhoneSessionAllowed } from "./phone-policy.js";

const PHONE_EVENTS_AS_IS: ReadonlySet<string> = new Set([
  "tick",
  "shutdown",
  "review.requested",
  "review.resolved",
  "exec.approval.requested",
  "exec.approval.resolved",
  "owner.notice",
]);

/** Sentinel: drop the event for this phone. */
export const DROP = Symbol("drop");

function sessionKeyOf(payload: unknown): string | undefined {
  const key = (payload as { sessionKey?: unknown } | null)?.sessionKey;
  return typeof key === "string" ? key : undefined;
}

/**
 * The payload a phone receives for this event, or DROP. Returns the same
 * object when nothing needs cutting, so the caller can reuse the shared frame.
 */
export function phoneEventPayload(
  event: string,
  payload: unknown,
  deviceId?: string | null,
): unknown {
  if (PHONE_EVENTS_AS_IS.has(event)) {
    return payload;
  }
  if (event === "chat") {
    return isPhoneSessionAllowed(sessionKeyOf(payload), deviceId) ? payload : DROP;
  }
  if (event === "agent") {
    const p = payload as {
      runId?: unknown;
      seq?: unknown;
      stream?: unknown;
      ts?: unknown;
      sessionKey?: unknown;
      data?: { phase?: unknown; name?: unknown; toolCallId?: unknown } | null;
    } | null;
    if (!p || p.stream !== "tool" || !isPhoneSessionAllowed(sessionKeyOf(p), deviceId)) {
      return DROP;
    }
    return {
      runId: p.runId,
      seq: p.seq,
      stream: "tool",
      ts: p.ts,
      sessionKey: p.sessionKey,
      data: {
        phase: typeof p.data?.phase === "string" ? p.data.phase : undefined,
        name: typeof p.data?.name === "string" ? p.data.name : undefined,
        toolCallId: typeof p.data?.toolCallId === "string" ? p.data.toolCallId : undefined,
      },
    };
  }
  return DROP;
}

/** The hello snapshot a phone sees: no paths, no presence, no health or runtime details. */
export function redactSnapshotForPhone(snapshot: Snapshot): Snapshot {
  return {
    presence: [],
    health: {},
    stateVersion: { ...snapshot.stateVersion },
    uptimeMs: snapshot.uptimeMs,
    sessionDefaults: snapshot.sessionDefaults,
    authMode: snapshot.authMode,
  } as unknown as Snapshot;
}
