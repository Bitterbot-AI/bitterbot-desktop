/**
 * PLAN-52 6.4: the compaction seam of the owned session.
 *
 * A policy decides when the context should be compacted after a turn and
 * produces the compaction entry. The session owns everything around it:
 * events, abort, writing the entry, rebuilding the in-memory messages, and
 * the overflow retry.
 *
 * Policies:
 * - "summary" (`summary-policy.ts`): pi's behaviour, an LLM summary of the
 *   history before a token-based cut point.
 * - "offload" (`offload-compaction.ts`, PLAN-52A): a deterministic horizon
 *   cut whose summary is a ledger of what was moved out of the window.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { HeartbeatStub, ToolOutputStub } from "../context-pruning/offload-stubs.js";
import type { StreamFn, ThinkingLevel } from "../loop/index.js";
import type { TranscriptEntry } from "../transcript/types.js";

export type CompactionReason = "manual" | "threshold" | "overflow";

export type CompactionSettings = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

/** What the session appends as a `compaction` entry and returns from `compact()`. */
export type CompactionOutcome = {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  /**
   * Tool outputs in the kept range to stub alongside the cut. The session
   * records them (`bitterbot.offload-prune`) and applies them to the context.
   */
  stubs?: ToolOutputStub[];
  /**
   * Bare heartbeat pairs in the kept range to drop from the window. Recorded
   * in the same `bitterbot.offload-prune` entry and re-applied at every build.
   */
  heartbeats?: HeartbeatStub[];
};

/**
 * No cut was possible (for example one huge turn), but stubbing tool outputs
 * frees enough. The session records and applies the stubs; no compaction
 * entry is written.
 */
export type StubsOnlyOutcome = { stubsOnly: true; stubs: ToolOutputStub[] };

export type CompactionPolicyResult = CompactionOutcome | StubsOnlyOutcome;

export function isStubsOnly(result: CompactionPolicyResult): result is StubsOnlyOutcome {
  return "stubsOnly" in result;
}

export type CompactionRequest = {
  reason: CompactionReason;
  /** Root-to-leaf entries of the current branch. */
  pathEntries: TranscriptEntry[];
  settings: CompactionSettings;
  model: Model<Api>;
  /**
   * Calls the model the way the session does (same stream function, so the
   * in-tree provider, request auth, and usage accounting all apply).
   */
  streamFn: StreamFn;
  apiKey?: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal: AbortSignal;
  thinkingLevel: ThinkingLevel;
};

export interface CompactionPolicy {
  readonly name: string;
  /** Threshold check after a turn, from the last assistant message's usage. */
  shouldCompact(input: {
    contextTokens: number;
    contextWindow: number;
    settings: CompactionSettings;
    /** "turn-end": after a run. "turn-start": the check before a new prompt. */
    phase: "turn-end" | "turn-start";
  }): boolean;
  /**
   * Compact the branch. Returns undefined when there is nothing to compact
   * (for example the last entry already is a compaction). A manual request
   * never gets a stubs-only result.
   */
  compact(request: CompactionRequest): Promise<CompactionPolicyResult | undefined>;
}
