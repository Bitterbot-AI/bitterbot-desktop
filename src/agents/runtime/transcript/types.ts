/**
 * PLAN-52 Phase 1: owned transcript store. Entry shapes of the session JSONL
 * format, version 3. The format is pi-coding-agent's (MIT, Mario Zechner /
 * pi-mono); it is kept byte-compatible because 14 readers in this repo and
 * every existing session file depend on it (PLAN-52 G2).
 *
 * Key order matters: entries are written with `JSON.stringify` on object
 * literals, so the order below is the order on disk. `custom` and
 * `custom_message` put `id / parentId / timestamp` last; everything else
 * puts them right after `type`.
 */

export const TRANSCRIPT_VERSION = 3;

export type SessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

type EntryBase = { id: string; parentId: string | null; timestamp: string };

export type MessageEntry = EntryBase & { type: "message"; message: TranscriptMessage };
export type ThinkingLevelChangeEntry = EntryBase & {
  type: "thinking_level_change";
  thinkingLevel: string;
};
export type ModelChangeEntry = EntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};
export type CompactionEntry<T = unknown> = EntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
};
export type CustomEntry<T = unknown> = EntryBase & {
  type: "custom";
  customType: string;
  data?: T;
};
export type SessionInfoEntry = EntryBase & { type: "session_info"; name: string };
export type CustomMessageEntry<T = unknown> = EntryBase & {
  type: "custom_message";
  customType: string;
  content: unknown;
  display: boolean;
  details?: T;
};
export type LabelEntry = EntryBase & { type: "label"; targetId: string; label?: string };
export type BranchSummaryEntry<T = unknown> = EntryBase & {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
};

export type TranscriptEntry =
  | MessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | CustomEntry
  | SessionInfoEntry
  | CustomMessageEntry
  | LabelEntry
  | BranchSummaryEntry;

export type FileEntry = SessionHeader | TranscriptEntry;

/** A message payload as stored in a `message` entry. Opaque here beyond `role`. */
export type TranscriptMessage = { role: string; [key: string]: unknown };

export type SessionContext = {
  messages: TranscriptMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
};

export type TreeNode = {
  entry: TranscriptEntry;
  children: TreeNode[];
  label?: string;
  labelTimestamp?: string;
};
