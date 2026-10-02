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
  /** Roll-up ranges for the ledger: what each compaction on the path hides now, any policy. */
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
 * Offload details of a compaction entry, or null when the entry was written
 * by another policy or the details are not in the expected shape (a damaged
 * or future-format entry must not break the view).
 */
function offloadDetailsOf(raw: unknown): OffloadCompactionDetails | null {
  const details = raw as Partial<OffloadCompactionDetails> | null | undefined;
  if (!details || typeof details !== "object" || details.policy !== "offload") {
    return null;
  }
  const elided = details.elided as Partial<OffloadCompactionDetails["elided"]> | undefined;
  if (
    !elided ||
    typeof elided !== "object" ||
    typeof elided.firstEntryId !== "string" ||
    typeof elided.lastEntryId !== "string"
  ) {
    return null;
  }
  return {
    ...(details as OffloadCompactionDetails),
    previousOffloads: Array.isArray(details.previousOffloads) ? details.previousOffloads : [],
  };
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
  const stubbedCallIds = new Map<string, StubKind>();
  let latest: TranscriptView["latestCompaction"] = null;
  /**
   * For every record on the path (messages and everything else): how many
   * message entries precede it. A compaction's `firstKeptEntryId` is often a
   * non-message entry (the cut walks back over custom entries), and the first
   * kept message is then the one at this index.
   */
  const messagesBefore = new Map<string, number>();
  /** Every compaction on the path, in order, with where its kept range starts. */
  const compactions: Array<{ id: string; firstKeptEntryId: string; position: number }> = [];
  let turn = 0;

  for (const r of path) {
    if (typeof r.id === "string") {
      messagesBefore.set(r.id, allEntries.length);
    }
    if (r.type === "compaction" && typeof r.id === "string") {
      latest = {
        id: r.id,
        firstKeptEntryId: typeof r.firstKeptEntryId === "string" ? r.firstKeptEntryId : "",
        summary: typeof r.summary === "string" ? r.summary : "",
        details: offloadDetailsOf(r.details),
      };
      compactions.push({
        id: r.id,
        firstKeptEntryId: latest.firstKeptEntryId,
        position: allEntries.length,
      });
      continue;
    }
    if (r.type === "custom" && r.customType === PRUNE_RECORD_CUSTOM_TYPE) {
      const data = r.data as
        | { stubs?: Array<{ entryId?: unknown; toolCallId?: unknown; kind?: unknown }> }
        | undefined;
      for (const s of data?.stubs ?? []) {
        const kind: StubKind = s.kind === "heartbeat_pair" ? "heartbeat_pair" : "tool_result";
        if (typeof s.entryId === "string") {
          stubbedIds.set(s.entryId, kind);
        } else if (typeof s.toolCallId === "string") {
          // Engine-side stubs are keyed by tool call id; resolved below.
          stubbedCallIds.set(s.toolCallId, kind);
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

  for (const e of allEntries) {
    if (e.toolCallId && stubbedCallIds.has(e.toolCallId)) {
      stubbedIds.set(e.id, stubbedCallIds.get(e.toolCallId)!);
    }
  }

  // Where a compaction's kept range starts, as an index into `allEntries`.
  // pi semantics: an id that is not on the path before the compaction keeps
  // nothing before it; everything after it stays visible.
  const keptStart = (c: { firstKeptEntryId: string; position: number }): number => {
    const index = messagesBefore.get(c.firstKeptEntryId);
    return index !== undefined && index <= c.position ? index : c.position;
  };
  // Only the latest compaction decides what is visible (as in buildSessionContext).
  const lastCompaction = compactions[compactions.length - 1];
  const visibleStart = lastCompaction ? keptStart(lastCompaction) : 0;
  const entries = allEntries.slice(visibleStart);

  // Roll-up for the ledger: one range per compaction on the path, whatever
  // policy wrote it, covering exactly what is hidden now. Built from the path
  // and not from an earlier ledger's details, so a summary compaction between
  // two offloads does not erase the earlier ranges.
  const previousOffloads: PreviousOffload[] = [];
  let covered = 0;
  for (const c of compactions) {
    const end = Math.min(keptStart(c), visibleStart);
    if (end > covered) {
      const first = allEntries[covered]!;
      const last = allEntries[end - 1]!;
      previousOffloads.push({
        compactionId: c.id,
        turnFrom: first.turn,
        turnTo: last.turn,
        firstEntryId: first.id,
        lastEntryId: last.id,
      });
      covered = end;
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
