/**
 * PLAN-52A tool-output stubs (T3), engine-side half.
 *
 * When a tool-heavy turn grows past the mid-turn trigger, the oldest tool
 * outputs are replaced in the window by a short stub that names the tool call
 * id; the full text stays in the transcript and `recall_range` returns it.
 * Unlike the progressive compression it replaces as the first step, a stub is
 * persisted (a pi v3 `custom` entry, `bitterbot.offload-prune`) and
 * re-applied at every context build, so it survives the next turn and a
 * restart.
 *
 * Stubs are keyed by `toolCallId`: both the in-memory message and the
 * transcript entry carry it, so no entry-id mapping is needed on either
 * engine. This module is pure; persistence is the caller's job.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { PRUNE_RECORD_CUSTOM_TYPE, STUB_MARKER_TOKENS } from "../compaction/types.js";

export type ToolOutputStub = {
  toolCallId: string;
  toolName?: string;
  /** Original text length in chars. */
  chars: number;
};

export type OffloadStubSettings = {
  /** Tool outputs below this estimate are never stubbed. */
  minTokens: number;
  /** Most recent tool outputs never stubbed. */
  spareRecent: number;
};

export const DEFAULT_STUB_SETTINGS: OffloadStubSettings = { minTokens: 1_000, spareRecent: 2 };

export const STUB_MARKER_PREFIX = "[tool output offloaded:";

export function renderStubText(stub: ToolOutputStub): string {
  return `${STUB_MARKER_PREFIX} ${stub.toolName ?? "tool"}, ${stub.chars.toLocaleString("en-US")} chars; full text: recall_range tool_call_id ${stub.toolCallId}]`;
}

type ToolResultLike = {
  role?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  content?: unknown;
};

function textOf(msg: ToolResultLike): string {
  const content = msg.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

function isStubbed(msg: ToolResultLike): boolean {
  return textOf(msg).startsWith(STUB_MARKER_PREFIX);
}

/**
 * Choose tool outputs to stub, oldest first, until the estimate reaches
 * `targetTokens`. `estimate` is the caller's per-message token estimate (pi's
 * `estimateTokens` on the pi engine).
 */
function hasImage(msg: ToolResultLike): boolean {
  return (
    Array.isArray(msg.content) &&
    msg.content.some((block) => (block as { type?: unknown } | null)?.type === "image")
  );
}

export function planMessageStubs(params: {
  messages: readonly AgentMessage[];
  estimate: (msg: AgentMessage) => number;
  totalTokens: number;
  targetTokens: number;
  settings?: Partial<OffloadStubSettings>;
}): ToolOutputStub[] {
  const settings = { ...DEFAULT_STUB_SETTINGS, ...params.settings };
  let current = params.totalTokens;
  if (current <= params.targetTokens) {
    return [];
  }
  const toolIdx: number[] = [];
  params.messages.forEach((m, i) => {
    if ((m as ToolResultLike).role === "toolResult") {
      toolIdx.push(i);
    }
  });
  const spare = new Set(toolIdx.slice(-Math.max(0, Math.floor(settings.spareRecent))));
  // Results the model has not seen yet (everything after the last assistant
  // message) are never stubbed, however many the last step produced.
  let lastAssistant = -1;
  params.messages.forEach((m, i) => {
    if ((m as ToolResultLike).role === "assistant") {
      lastAssistant = i;
    }
  });
  const out: ToolOutputStub[] = [];
  for (const i of toolIdx) {
    if (current <= params.targetTokens) {
      break;
    }
    const msg = params.messages[i] as AgentMessage & ToolResultLike;
    if (spare.has(i) || typeof msg.toolCallId !== "string" || !msg.toolCallId || isStubbed(msg)) {
      continue;
    }
    if (i > lastAssistant || hasImage(msg)) {
      // Unseen by the model, or an image that recall_range could not return.
      continue;
    }
    const tokens = params.estimate(msg);
    if (tokens < settings.minTokens) {
      continue;
    }
    const saved = tokens - STUB_MARKER_TOKENS;
    if (saved <= 0) {
      continue;
    }
    out.push({
      toolCallId: msg.toolCallId,
      toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
      chars: textOf(msg).length,
    });
    current -= saved;
  }
  return out;
}

/**
 * Replace the content of stubbed tool results with the stub marker. Returns a
 * new array; untouched messages keep their identity. Idempotent.
 */
export function applyStubsToMessages(
  messages: readonly AgentMessage[],
  stubs: ReadonlyMap<string, ToolOutputStub>,
): { messages: AgentMessage[]; applied: number } {
  if (stubs.size === 0) {
    return { messages: [...messages], applied: 0 };
  }
  let applied = 0;
  const out = messages.map((m) => {
    const msg = m as AgentMessage & ToolResultLike;
    if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") {
      return m;
    }
    const stub = stubs.get(msg.toolCallId);
    if (!stub || isStubbed(msg)) {
      return m;
    }
    applied++;
    return {
      ...m,
      content: [{ type: "text", text: renderStubText(stub) }],
    } as unknown as AgentMessage;
  });
  return { messages: out, applied };
}

type EntryLike = { type?: unknown; customType?: unknown; data?: unknown };

/**
 * One message of a bare heartbeat pair (the prompt, or the acknowledgement)
 * that a horizon cut left in the kept range. The pair carries no information
 * the ledger does not already count, so it is dropped from the window.
 *
 * Keyed by role, message timestamp and text length: the in-memory message
 * has no entry id, and both it and the transcript entry carry those three.
 */
export type HeartbeatStub = {
  entryId: string;
  role: "user" | "assistant";
  timestamp: number;
  chars: number;
};

/** The `data` payload of a `bitterbot.offload-prune` custom entry for these stubs. */
export function buildPruneRecordData(
  stubs: readonly ToolOutputStub[],
  trigger: string,
  heartbeats: readonly HeartbeatStub[] = [],
) {
  return {
    version: 1 as const,
    trigger,
    stubs: [
      ...stubs.map((s) => ({
        toolCallId: s.toolCallId,
        kind: "tool_result" as const,
        chars: s.chars,
        ...(s.toolName ? { toolName: s.toolName } : {}),
      })),
      ...heartbeats.map((h) => ({
        entryId: h.entryId,
        kind: "heartbeat_pair" as const,
        chars: h.chars,
        role: h.role,
        timestamp: h.timestamp,
      })),
    ],
  };
}

/** Collect every heartbeat-pair stub recorded on a branch path. */
export function collectHeartbeatStubs(entries: readonly EntryLike[]): HeartbeatStub[] {
  const out: HeartbeatStub[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== PRUNE_RECORD_CUSTOM_TYPE) {
      continue;
    }
    const data = e.data as { stubs?: unknown } | undefined;
    if (!Array.isArray(data?.stubs)) {
      continue;
    }
    for (const raw of data.stubs as Array<Record<string, unknown>>) {
      if (
        raw?.kind !== "heartbeat_pair" ||
        (raw.role !== "user" && raw.role !== "assistant") ||
        typeof raw.timestamp !== "number" ||
        typeof raw.entryId !== "string"
      ) {
        continue;
      }
      out.push({
        entryId: raw.entryId,
        role: raw.role,
        timestamp: raw.timestamp,
        chars: typeof raw.chars === "number" ? raw.chars : 0,
      });
    }
  }
  return out;
}

/**
 * Drop recorded heartbeat pairs from the window. Only a whole turn goes: a
 * recorded prompt followed by nothing but recorded acknowledgements, up to the
 * next user message. Anything else is left alone, so the roles still
 * alternate. Returns a new array; idempotent.
 */
export function applyHeartbeatStubs(
  messages: readonly AgentMessage[],
  stubs: readonly HeartbeatStub[],
): { messages: AgentMessage[]; removed: number } {
  if (stubs.length === 0) {
    return { messages: [...messages], removed: 0 };
  }
  // Role, timestamp and text length together: two messages of one role can
  // share a millisecond, and a wrong match would drop a real turn.
  const recorded = new Set(stubs.map((stub) => `${stub.role}:${stub.timestamp}:${stub.chars}`));
  const isRecorded = (message: AgentMessage | undefined, role: "user" | "assistant") => {
    const typed = message as (ToolResultLike & { timestamp?: unknown }) | undefined;
    return (
      typed?.role === role &&
      typeof typed.timestamp === "number" &&
      recorded.has(`${role}:${typed.timestamp}:${textOf(typed).length}`)
    );
  };
  const out: AgentMessage[] = [];
  let removed = 0;
  for (let i = 0; i < messages.length; i++) {
    if (!isRecorded(messages[i], "user")) {
      out.push(messages[i]!);
      continue;
    }
    let end = i + 1;
    while (end < messages.length && isRecorded(messages[end], "assistant")) {
      end++;
    }
    const acked = end > i + 1;
    const turnEndsThere =
      end === messages.length || (messages[end] as { role?: unknown }).role === "user";
    if (acked && turnEndsThere) {
      removed += end - i;
      i = end - 1;
      continue;
    }
    out.push(messages[i]!);
  }
  return { messages: out, removed };
}

/** Collect every tool-output stub recorded on a branch path (pi `getBranch()` entries). */
export function collectStubRecords(entries: readonly EntryLike[]): Map<string, ToolOutputStub> {
  const out = new Map<string, ToolOutputStub>();
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== PRUNE_RECORD_CUSTOM_TYPE) {
      continue;
    }
    const data = e.data as { stubs?: unknown } | undefined;
    if (!Array.isArray(data?.stubs)) {
      continue;
    }
    for (const raw of data.stubs as Array<Record<string, unknown>>) {
      if (
        raw?.kind === "heartbeat_pair" ||
        typeof raw?.toolCallId !== "string" ||
        !raw.toolCallId
      ) {
        continue;
      }
      out.set(raw.toolCallId, {
        toolCallId: raw.toolCallId,
        toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
        chars: typeof raw.chars === "number" ? raw.chars : 0,
      });
    }
  }
  return out;
}

export { PRUNE_RECORD_CUSTOM_TYPE };
