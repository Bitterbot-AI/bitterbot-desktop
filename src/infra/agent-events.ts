import type { VerboseLevel } from "../auto-reply/thinking.js";

export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "user"
  | (string & {});

/**
 * PLAN-44 Phase 0 (D-6): cap on the journaled user-turn text. Matches the
 * per-block cap the skill-evolution trace formatter applies to tool results,
 * so the task never dominates a 15k-char trace log.
 */
export const USER_TURN_EVENT_MAX_CHARS = 4_000;

/**
 * Emit the `user` stream event that records WHAT a run was asked to do.
 * Audit finding (2026-09-03): the journal carried assistant, tool, and
 * lifecycle streams but never the prompt, so every downstream consumer
 * (trace labeler, wiki maintainer, skill proposer) saw what the agent did
 * and never what it was asked. One event per run; the trace reconstructor
 * keeps the first. Origin/trust is derived from the session key at read
 * time (src/memory/skill-evolution/run-origin.ts), never trusted from here.
 */
const userTurnEmitted = new Set<string>();
const USER_TURN_EMITTED_MAX = 2_000;

export function emitUserTurnEvent(params: {
  runId: string;
  text: string;
  sessionKey?: string;
  isHeartbeat?: boolean;
  channel?: string;
}) {
  // Once per run: failover / compaction retries re-enter the runner with
  // the same runId (adversarial M3). Bounded FIFO so the set cannot grow
  // with process lifetime.
  if (userTurnEmitted.has(params.runId)) {
    return;
  }
  userTurnEmitted.add(params.runId);
  if (userTurnEmitted.size > USER_TURN_EMITTED_MAX) {
    const oldest = userTurnEmitted.values().next().value;
    if (oldest !== undefined) {
      userTurnEmitted.delete(oldest);
    }
  }
  const text = params.text ?? "";
  emitAgentEvent({
    runId: params.runId,
    stream: "user",
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    data: {
      text:
        text.length > USER_TURN_EVENT_MAX_CHARS ? text.slice(0, USER_TURN_EVENT_MAX_CHARS) : text,
      chars: text.length,
      isHeartbeat: params.isHeartbeat === true,
      ...(params.channel ? { channel: params.channel } : {}),
    },
  });
}

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
  /** PLAN-16: correlates a run to a long-horizon Task, when one exists. */
  taskId?: string;
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** PLAN-16: when set, every event from this run carries the same taskId. */
  taskId?: string;
};

// Keep per-run counters so streams stay strictly monotonic per runId.
const seqByRun = new Map<string, number>();
const listeners = new Set<(evt: AgentEventPayload) => void>();
const runContextById = new Map<string, AgentRunContext>();

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const existing = runContextById.get(runId);
  if (!existing) {
    runContextById.set(runId, { ...context });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
  if (context.taskId && existing.taskId !== context.taskId) {
    existing.taskId = context.taskId;
  }
}

export function getAgentRunContext(runId: string) {
  return runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  runContextById.delete(runId);
}

export function resetAgentRunContextForTest() {
  runContextById.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const nextSeq = (seqByRun.get(event.runId) ?? 0) + 1;
  seqByRun.set(event.runId, nextSeq);
  const context = runContextById.get(event.runId);
  const sessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim()
      ? event.sessionKey
      : context?.sessionKey;
  const taskId =
    typeof event.taskId === "string" && event.taskId.trim() ? event.taskId : context?.taskId;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    ...(taskId ? { taskId } : {}),
    seq: nextSeq,
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      /* ignore */
    }
  }
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
