/**
 * PLAN-52A offload compaction policy: shared types.
 *
 * Everything here is engine-agnostic and pure. The policy plans over a
 * `PolicyEntry[]` (the current branch path of a session transcript, in order)
 * and returns drafts of the two entries the engine persists: a pi v3
 * `compaction` entry (horizon cut, ledger as `summary`) and a pi v3 `custom`
 * entry `bitterbot.offload-prune` (holes: stubbed tool outputs and heartbeat
 * pairs, re-applied by the context-pruning stage at every context build).
 */

export type CompactionTrigger = "turn-end" | "turn-start" | "mid-turn" | "overflow" | "manual";

export type PolicyEntryRole = "user" | "assistant" | "toolResult";

export type PolicyEntry = {
  /** pi v3 entry id. */
  id: string;
  /** 1-based JSONL line number. */
  line: number;
  role: PolicyEntryRole;
  /** Text blocks joined with newlines (tool outputs: their text). */
  text: string;
  /** Estimated tokens for this entry as rendered to the model (see estimate.ts). */
  tokens: number;
  /** Message timestamp (epoch ms) when present. */
  timestamp?: number;
  /** Turn ordinal: count of user-role entries on the path up to and including this one. */
  turn: number;
  /** toolResult rows: the tool that produced it and the call it answers. */
  toolName?: string;
  toolCallId?: string;
  /** assistant rows: ids of the tool calls it issued. */
  toolCallIds: string[];
  /** Number of image blocks (counted separately in the estimate). */
  images: number;
  /** user rows: the configured heartbeat prompt. */
  isHeartbeatPrompt: boolean;
  /** assistant rows: a bare HEARTBEAT_OK acknowledgement. */
  isHeartbeatAck: boolean;
  /**
   * assistant rows: the real prompt size of the call that produced this
   * message (`usage.input + cacheRead + cacheWrite`), when the transcript
   * recorded it. The runtime prefers it over the estimate for trigger checks,
   * as pi does; the eval harness uses it to calibrate the estimate.
   */
  promptTokensActual?: number;
};

/** One user turn: the user entry and everything up to the next user entry. */
export type PolicyTurn = {
  /** Turn ordinal (same as the entries' `turn`). */
  turn: number;
  /** Index range into the entries array, inclusive. */
  startIndex: number;
  endIndex: number;
  tokens: number;
  /** Heartbeat prompt answered only by a bare ack, no tool calls: safe to drop whole. */
  isHeartbeatPair: boolean;
};

export type StubKind = "tool_result" | "heartbeat_pair";

export type PlannedStub = {
  entryId: string;
  kind: StubKind;
  /** Original text length in chars (for the stub marker and the record). */
  chars: number;
  /** Tokens saved by stubbing (original estimate minus the stub's own size). */
  tokensSaved: number;
  /** tool_result stubs: the tool name, for the marker. */
  toolName?: string;
};

export type HorizonCut = {
  /** Index of the first kept entry. */
  cutIndex: number;
  firstKeptEntryId: string;
  /** Turn ordinals of the elided range (inclusive). */
  turnFrom: number;
  turnTo: number;
  elidedTokens: number;
  keptTokens: number;
};

/** The elided range as recorded in `details.elided` and rendered in the ledger. */
export type ElidedRange = {
  sessionId: string;
  firstEntryId: string;
  lastEntryId: string;
  jsonlLineFrom: number;
  jsonlLineTo: number;
  turnFrom: number;
  turnTo: number;
  messages: number;
  userTurns: number;
  heartbeats: number;
  toolCalls: number;
  estTokens: number;
  firstTs?: number;
  lastTs?: number;
};

/** A previous offload on this session, for the ledger's roll-up line. */
export type PreviousOffload = {
  compactionId: string;
  turnFrom: number;
  turnTo: number;
  firstEntryId: string;
  lastEntryId: string;
};

export type LedgerThread = {
  turn: number;
  entryId: string;
  /** First line of the user message, trimmed and capped. */
  text: string;
};

export type LedgerInput = {
  elided: ElidedRange;
  threads: LedgerThread[];
  /** Bare heartbeat pairs inside the elided range. */
  heartbeats: { count: number; lastTs?: number };
  /** Active PLAN-16 tasks, working-memory scratch headings, anything the engine wants to carry. */
  openItems: string[];
  lastExchange?: { user?: string; assistant?: string };
  previousOffloads: PreviousOffload[];
  workingMemoryFlushed: boolean;
  /** Optional cheap-model summary, already labelled as derived from tool output by the caller. */
  summary?: string;
  /** Ledger budget in tokens (chars/4). Default 1200. */
  budgetTokens?: number;
};

/** Draft of the pi v3 `compaction` entry (the engine assigns id/parentId/timestamp). */
export type CompactionEntryDraft = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: OffloadCompactionDetails;
};

export type OffloadCompactionDetails = {
  policy: "offload";
  version: 1;
  trigger: CompactionTrigger;
  elided: ElidedRange;
  kept: { firstEntryId: string; estTokens: number };
  previousCompactionId: string | null;
  previousOffloads: PreviousOffload[];
  workingMemoryFlushed: boolean;
  summary?: { model: string; costUsd: number; inputTokens: number; outputTokens: number };
};

/** Draft of the pi v3 `custom` entry `bitterbot.offload-prune`. */
export type PruneRecordDraft = {
  customType: "bitterbot.offload-prune";
  data: {
    version: 1;
    trigger: CompactionTrigger;
    /**
     * `entryId` when the planner works on transcript entries, `toolCallId` when
     * the engine stubs in-memory messages (tool results carry it in both the
     * message and the transcript entry). At least one is present.
     */
    stubs: Array<{
      entryId?: string;
      toolCallId?: string;
      kind: StubKind;
      chars: number;
      toolName?: string;
    }>;
  };
};

export const PRUNE_RECORD_CUSTOM_TYPE = "bitterbot.offload-prune";

/** Tokens a tool-output stub marker costs in the window (conservative). */
export const STUB_MARKER_TOKENS = 40;

export type OffloadPlan = {
  /** What the plan does. `none` = nothing to elide at this trigger. */
  kind: "horizon" | "stubs" | "none";
  trigger: CompactionTrigger;
  cut?: HorizonCut;
  stubs: PlannedStub[];
  compaction?: CompactionEntryDraft;
  prune?: PruneRecordDraft;
  estimates: { before: number; after: number; target: number };
  /** Human-readable reasons, for logs and the eval report. */
  notes: string[];
};
