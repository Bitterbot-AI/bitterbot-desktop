/**
 * Build the policy's view of a session: the current branch path of the pi v3
 * JSONL, as `PolicyEntry[]`, plus what earlier offloads already did to it.
 *
 * Rules:
 * - Path = leaf (last record with an id) back to the root through `parentId`.
 *   Forked siblings are not part of the model's history.
 * - Turn ordinals are assigned over the WHOLE path before anything is
 *   excluded, so "turn 9" means the same row before and after an offload.
 * - The latest `compaction` entry on the path (any policy) hides everything
 *   before its `firstKeptEntryId`, exactly as pi's buildSessionContext does.
 *   If it carries offload details, its ranges feed the next ledger's roll-up.
 * - `custom` entries of type `bitterbot.offload-prune` on the path contribute
 *   their stubbed entry ids, so a stub is never counted twice.
 */

import fs from "node:fs/promises";
import { estimateMessageTokens } from "./estimate.js";
import { isHeartbeatAckText, isHeartbeatPromptText, transcriptMessageText } from "./heartbeat.js";
import {
  PRUNE_RECORD_CUSTOM_TYPE,
  type OffloadCompactionDetails,
  type PolicyEntry,
  type PreviousOffload,
  type StubKind,
} from "./types.js";

export type TranscriptView = {
  sessionId: string;
  /** Path entries visible to the model (after the latest compaction's cut). */
  entries: PolicyEntry[];
  /** Every message entry on the path, including those hidden by the compaction. */
  allEntries: PolicyEntry[];
  latestCompaction: {
    id: string;
    firstKeptEntryId: string;
    summary: string;
    details: OffloadCompactionDetails | null;
  } | null;
  /** Roll-up ranges for the ledger (own offloads only; a `summary`-policy entry has none). */
  previousOffloads: PreviousOffload[];
  /** Entry ids already stubbed by earlier prune records on the path. */
  stubbedIds: Map<string, StubKind>;
};

type RawRecord = Record<string, unknown> & { __line: number };

export function parseJsonl(raw: string): RawRecord[] {
  const out: RawRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec && typeof rec === "object") {
        out.push({ ...rec, __line: i + 1 });
      }
    } catch {
      // repaired-file semantics: a broken line is skipped
    }
  }
  return out;
}

function pathRecords(records: RawRecord[]): RawRecord[] {
  const byId = new Map<string, RawRecord>();
  let leaf: RawRecord | undefined;
  for (const r of records) {
    if (typeof r.id === "string" && r.id) {
      byId.set(r.id, r);
      leaf = r;
    }
  }
  if (!leaf) {
    // Legacy transcript without ids: file order.
    return records.filter((r) => r.type !== "session");
  }
  const path: RawRecord[] = [];
  const seen = new Set<string>();
  let cursor: RawRecord | undefined = leaf;
  while (cursor && typeof cursor.id === "string" && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    const parent: unknown = cursor.parentId;
    cursor = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  path.reverse();
  return path;
}

/** `usage.input + cacheRead + cacheWrite` of an assistant message, when recorded. */
export function actualPromptTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const u = usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  const parts = [u.input, u.cacheRead, u.cacheWrite].map((v) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0,
  );
  const total = parts[0]! + parts[1]! + parts[2]!;
  return total > 0 ? total : undefined;
}

function toolCallIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { id?: unknown }).id === "string"
    ) {
      ids.push((block as { id: string }).id);
    }
  }
  return ids;
}

/**
 * Build the view from parsed records. `heartbeatPrompts` is the configured
 * prompt set (`resolveHeartbeatPromptSet`); pass `[]` to disable detection.
 */
export function buildTranscriptView(params: {
  records: RawRecord[];
  sessionIdFallback: string;
  heartbeatPrompts: readonly string[];
}): TranscriptView {
  let sessionId = params.sessionIdFallback;
  for (const r of params.records) {
    if (r.type === "session" && typeof r.id === "string") {
      sessionId = r.id;
      break;
    }
  }
  const path = pathRecords(params.records);

  const allEntries: PolicyEntry[] = [];
  const stubbedIds = new Map<string, StubKind>();
  let latest: TranscriptView["latestCompaction"] = null;
  let turn = 0;

  for (const r of path) {
    if (r.type === "compaction" && typeof r.id === "string") {
      const details = r.details as OffloadCompactionDetails | undefined;
      latest = {
        id: r.id,
        firstKeptEntryId: typeof r.firstKeptEntryId === "string" ? r.firstKeptEntryId : "",
        summary: typeof r.summary === "string" ? r.summary : "",
        details: details && details.policy === "offload" ? details : null,
      };
      continue;
    }
    if (r.type === "custom" && r.customType === PRUNE_RECORD_CUSTOM_TYPE) {
      const data = r.data as { stubs?: Array<{ entryId?: unknown; kind?: unknown }> } | undefined;
      for (const s of data?.stubs ?? []) {
        if (typeof s.entryId === "string") {
          stubbedIds.set(s.entryId, s.kind === "heartbeat_pair" ? "heartbeat_pair" : "tool_result");
        }
      }
      continue;
    }
    if (r.type !== "message" || typeof r.id !== "string") {
      continue;
    }
    const message = r.message as Record<string, unknown> | undefined;
    const role = message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") {
      continue;
    }
    if (role === "user") {
      turn++;
    }
    const text = transcriptMessageText(message);
    const { tokens, images } = estimateMessageTokens(message ?? {});
    const ts = message && typeof message.timestamp === "number" ? message.timestamp : undefined;
    allEntries.push({
      id: r.id,
      line: r.__line,
      role,
      text,
      tokens,
      timestamp: ts,
      turn,
      toolName:
        role === "toolResult" && typeof message?.toolName === "string"
          ? message.toolName
          : undefined,
      toolCallId:
        role === "toolResult" && typeof message?.toolCallId === "string"
          ? message.toolCallId
          : undefined,
      toolCallIds: role === "assistant" ? toolCallIdsOf(message?.content) : [],
      images,
      isHeartbeatPrompt: role === "user" && isHeartbeatPromptText(text, params.heartbeatPrompts),
      isHeartbeatAck: role === "assistant" && isHeartbeatAckText(text),
      promptTokensActual: role === "assistant" ? actualPromptTokens(message?.usage) : undefined,
    });
  }

  let entries = allEntries;
  const previousOffloads: PreviousOffload[] = [];
  if (latest) {
    const idx = allEntries.findIndex((e) => e.id === latest!.firstKeptEntryId);
    // pi semantics: an unknown firstKeptEntryId keeps nothing before the compaction.
    entries = idx >= 0 ? allEntries.slice(idx) : [];
    if (latest.details) {
      previousOffloads.push(...latest.details.previousOffloads);
      previousOffloads.push({
        compactionId: latest.id,
        turnFrom: latest.details.elided.turnFrom,
        turnTo: latest.details.elided.turnTo,
        firstEntryId: latest.details.elided.firstEntryId,
        lastEntryId: latest.details.elided.lastEntryId,
      });
    }
  }

  return { sessionId, entries, allEntries, latestCompaction: latest, previousOffloads, stubbedIds };
}

/** Read a transcript file and build the view. */
export async function loadTranscriptView(params: {
  filePath: string;
  sessionIdFallback: string;
  heartbeatPrompts: readonly string[];
}): Promise<TranscriptView> {
  const raw = await fs.readFile(params.filePath, "utf-8");
  return buildTranscriptView({
    records: parseJsonl(raw),
    sessionIdFallback: params.sessionIdFallback,
    heartbeatPrompts: params.heartbeatPrompts,
  });
}
