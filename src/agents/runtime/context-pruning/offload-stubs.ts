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
  const out: ToolOutputStub[] = [];
  for (const i of toolIdx) {
    if (current <= params.targetTokens) {
      break;
    }
    const msg = params.messages[i] as AgentMessage & ToolResultLike;
    if (spare.has(i) || typeof msg.toolCallId !== "string" || !msg.toolCallId || isStubbed(msg)) {
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

/** The `data` payload of a `bitterbot.offload-prune` custom entry for these stubs. */
export function buildPruneRecordData(stubs: readonly ToolOutputStub[], trigger: string) {
  return {
    version: 1 as const,
    trigger,
    stubs: stubs.map((s) => ({
      toolCallId: s.toolCallId,
      kind: "tool_result" as const,
      chars: s.chars,
      ...(s.toolName ? { toolName: s.toolName } : {}),
    })),
  };
}

type EntryLike = { type?: unknown; customType?: unknown; data?: unknown };

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
