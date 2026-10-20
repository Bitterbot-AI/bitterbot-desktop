/**
 * PLAN-52 Phase 3: cut point and preparation for summary compaction.
 *
 * Ported from pi-coding-agent 0.73.1 (MIT, Mario Zechner / pi-mono),
 * `core/compaction/compaction.js`: `findTurnStartIndex`, `findCutPoint`,
 * `prepareCompaction` and their private helpers.
 *
 * Differences from the original:
 *
 * 1. Typing (entries are our `TranscriptEntry`).
 * 2. `prepareCompaction` uses our `buildSessionContext` port, which stops on a
 *    parent cycle where pi's would loop forever.
 *
 * Kept as in pi, on purpose:
 * - Valid cut points are `message` entries with any role except `toolResult`
 *   (a tool result must stay with its tool call), plus `branch_summary` and
 *   `custom_message` entries.
 * - The backwards walk only counts `message` entries; `custom_message` and
 *   `branch_summary` entries add no tokens to the kept tail.
 * - After the cut is chosen it moves back over the non-message entries right
 *   before it (settings changes, labels, custom entries), stopping at a
 *   message or a compaction. If it lands on such an entry the cut is not "at a
 *   user message", so it is reported as a split turn whenever an earlier turn
 *   start exists in range, even when the first kept message is a user message.
 * - A cut on a `bashExecution` message, a `custom_message` or a
 *   `branch_summary` reports `isSplitTurn: true` with `turnStartIndex` equal
 *   to the cut itself, which gives an empty turn prefix.
 * - File lists stored in the previous compaction's `details` are carried
 *   forward unless that compaction came from a hook (`fromHook`).
 */
import {
  buildSessionContext,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../../transcript/context.js";
import type { CompactionEntry, TranscriptEntry } from "../../transcript/types.js";
import { type SessionMessage, toSessionMessage } from "./messages.js";
import { createFileOps, extractFileOpsFromMessage, type FileOperations } from "./serialize.js";
import { type CompactionSettings, estimateContextTokens, estimateTokens } from "./tokens.js";

/** File operations of the summarized messages plus those of the previous compaction. */
function extractFileOperations(
  messages: readonly SessionMessage[],
  entries: readonly TranscriptEntry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (!prevCompaction.fromHook && prevCompaction.details) {
      const details = prevCompaction.details as { readFiles?: unknown; modifiedFiles?: unknown };
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles as string[]) {
          fileOps.read.add(f);
        }
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles as string[]) {
          fileOps.edited.add(f);
        }
      }
    }
  }
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }
  return fileOps;
}

/** The message an entry contributes to the LLM context, if any. */
function getMessageFromEntry(entry: TranscriptEntry): SessionMessage | undefined {
  if (entry.type === "message") {
    return toSessionMessage(entry.message);
  }
  if (entry.type === "custom_message") {
    return toSessionMessage(
      createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      ),
    );
  }
  if (entry.type === "branch_summary") {
    return toSessionMessage(
      createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
    );
  }
  if (entry.type === "compaction") {
    return toSessionMessage(
      createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
    );
  }
  return undefined;
}

/** Same, but a compaction entry contributes nothing (its summary is passed separately). */
function getMessageFromEntryForCompaction(entry: TranscriptEntry): SessionMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return getMessageFromEntry(entry);
}

/** Indices in `[startIndex, endIndex)` where a cut may be placed. */
function findValidCutPoints(
  entries: readonly TranscriptEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (entry.type === "message") {
      switch (entry.message.role) {
        case "bashExecution":
        case "custom":
        case "branchSummary":
        case "compactionSummary":
        case "user":
        case "assistant":
          cutPoints.push(i);
          break;
        default:
          // toolResult (and any unknown role): never a cut point.
          break;
      }
    }
    // branch_summary and custom_message reach the model as user messages.
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/**
 * Index of the entry that starts the turn containing `entryIndex`: the
 * closest user message, bash execution, `branch_summary` or `custom_message`
 * at or before it, not going below `startIndex`. Returns -1 if there is none.
 */
export function findTurnStartIndex(
  entries: readonly TranscriptEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user" || role === "bashExecution") {
        return i;
      }
    }
  }
  return -1;
}

export interface CutPointResult {
  /** Index of the first entry to keep. */
  firstKeptEntryIndex: number;
  /** Index of the entry that starts the turn being split, or -1. */
  turnStartIndex: number;
  /** Whether the cut falls inside a turn (the cut entry is not a user message). */
  isSplitTurn: boolean;
}

/**
 * Find the cut that keeps about `keepRecentTokens` of recent messages.
 *
 * Walk backwards from the newest entry adding up message estimates; at the
 * first message where the sum reaches `keepRecentTokens`, cut at the closest
 * valid cut point at or after it. If the budget is never reached, keep
 * everything from the first valid cut point. Only entries in
 * `[startIndex, endIndex)` are considered.
 */
export function findCutPoint(
  entries: readonly TranscriptEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  if (cutPoints.length === 0) {
    return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  }

  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") {
      continue;
    }
    accumulatedTokens += estimateTokens(toSessionMessage(entry.message));
    if (accumulatedTokens >= keepRecentTokens) {
      // The closest valid cut point at or after this entry; if there is none
      // (only tool results follow), the default above stays.
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  // Pull the non-message entries right before the cut into the kept part.
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      break;
    }
    cutIndex--;
  }

  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return {
    firstKeptEntryIndex: cutIndex,
    turnStartIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
  };
}

export interface CompactionPreparation {
  /** Id of the first entry to keep. */
  firstKeptEntryId: string;
  /** Messages that are summarized and dropped from the context. */
  messagesToSummarize: SessionMessage[];
  /** Start of the split turn, summarized separately (empty unless splitting). */
  turnPrefixMessages: SessionMessage[];
  /** Whether the cut falls inside a turn. */
  isSplitTurn: boolean;
  /** Context tokens before compaction. */
  tokensBefore: number;
  /** Summary of the previous compaction, to be updated instead of rewritten. */
  previousSummary?: string;
  /** File operations of the summarized messages and the previous compaction. */
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/**
 * Decide what a compaction of `pathEntries` (root to leaf) would do. Pure; no
 * model call. Returns undefined when the last entry already is a compaction,
 * or when there is no entry to keep from (an empty path).
 */
export function prepareCompaction(
  pathEntries: readonly TranscriptEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
    return undefined;
  }

  let prevCompactionIndex = -1;
  let prevCompaction: CompactionEntry | undefined;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const entry = pathEntries[i];
    if (entry.type === "compaction") {
      prevCompactionIndex = i;
      prevCompaction = entry;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompaction) {
    previousSummary = prevCompaction.summary;
    const firstKeptEntryId = prevCompaction.firstKeptEntryId;
    const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
    boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }
  const boundaryEnd = pathEntries.length;

  const contextMessages = buildSessionContext(pathEntries).messages.map(toSessionMessage);
  const tokensBefore = estimateContextTokens(contextMessages).tokens;

  const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

  const firstKeptEntry: TranscriptEntry | undefined = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined;
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

  const messagesToSummarize: SessionMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(pathEntries[i]);
    if (msg) {
      messagesToSummarize.push(msg);
    }
  }

  const turnPrefixMessages: SessionMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
      const msg = getMessageFromEntryForCompaction(pathEntries[i]);
      if (msg) {
        turnPrefixMessages.push(msg);
      }
    }
  }

  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return {
    firstKeptEntryId,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cutPoint.isSplitTurn,
    tokensBefore,
    previousSummary,
    fileOps,
    settings,
  };
}
