/**
 * PLAN-52 Phase 1: build the model-visible context from transcript entries.
 *
 * Ported from pi-coding-agent 0.73.1 `buildSessionContext` (MIT, Mario
 * Zechner / pi-mono); the algorithm must stay identical so every existing
 * session renders the same on both engines (PLAN-52 G3). Differences from the
 * original: typing, the path walk stops on a parent cycle, and an entry whose
 * parent is missing from the file continues at the previous entry in file
 * order (see `parentOf`).
 *
 * Rules:
 * - The path is leaf -> root through `parentId`; an unknown or undefined leaf
 *   falls back to the last entry; a `null` leaf means "empty".
 * - `thinkingLevel` and `model` are read from the WHOLE path (also from
 *   entries a compaction hides).
 * - The last `compaction` on the path wins: its summary message first, then
 *   path entries from `firstKeptEntryId` up to the compaction, then everything
 *   after it. A `firstKeptEntryId` that is not on the path keeps nothing
 *   before the compaction.
 */

import type {
  CompactionEntry,
  SessionContext,
  TranscriptEntry,
  TranscriptMessage,
} from "./types.js";

function ms(timestamp: string): number {
  return new Date(timestamp).getTime();
}

export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): TranscriptMessage {
  return { role: "branchSummary", summary, fromId, timestamp: ms(timestamp) };
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
): TranscriptMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: ms(timestamp) };
}

export function createCustomMessage(
  customType: string,
  content: unknown,
  display: boolean,
  details: unknown,
  timestamp: string,
): TranscriptMessage {
  return { role: "custom", customType, content, display, details, timestamp: ms(timestamp) };
}

/**
 * The parent of an entry. When `parentId` names an entry that is not in the
 * file (a damaged line was dropped by the repair, or never fully written),
 * the previous entry in file order stands in for it. Upstream ends the path
 * there, which hides the whole conversation before the damaged line.
 */
export function parentOf(
  entry: TranscriptEntry,
  index: Map<string, TranscriptEntry>,
  entries: readonly TranscriptEntry[],
): TranscriptEntry | undefined {
  if (!entry.parentId) {
    return undefined;
  }
  const parent = index.get(entry.parentId);
  if (parent) {
    return parent;
  }
  const position = entries.indexOf(entry);
  return position > 0 ? entries[position - 1] : undefined;
}

export function buildSessionContext(
  entries: readonly TranscriptEntry[],
  leafId?: string | null,
  byId?: Map<string, TranscriptEntry>,
): SessionContext {
  let index = byId;
  if (!index) {
    index = new Map();
    for (const entry of entries) {
      index.set(entry.id, entry);
    }
  }
  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }
  let leaf: TranscriptEntry | undefined = leafId ? index.get(leafId) : undefined;
  if (!leaf) {
    leaf = entries[entries.length - 1];
  }
  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  // Unlike upstream, stop on a parent cycle (a damaged file must not hang the gateway).
  const path: TranscriptEntry[] = [];
  const seen = new Set<TranscriptEntry>();
  let current: TranscriptEntry | undefined = leaf;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    current = parentOf(current, index, entries);
  }

  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  let compaction: CompactionEntry | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = {
        provider: entry.message.provider as string,
        modelId: entry.message.model as string,
      };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: TranscriptMessage[] = [];
  const emit = (entry: TranscriptEntry) => {
    if (entry.type === "message") {
      messages.push(entry.message);
    } else if (entry.type === "custom_message") {
      messages.push(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  };

  if (compaction) {
    const c: CompactionEntry = compaction;
    messages.push(createCompactionSummaryMessage(c.summary, c.tokensBefore, c.timestamp));
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === c.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i]!;
      if (entry.id === c.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        emit(entry);
      }
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      emit(path[i]!);
    }
  } else {
    for (const entry of path) {
      emit(entry);
    }
  }

  return { messages, thinkingLevel, model };
}
