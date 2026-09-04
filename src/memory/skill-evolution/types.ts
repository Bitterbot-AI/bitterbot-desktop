/**
 * PLAN-42 skill evolution — shared types for the trace pipeline.
 *
 * The raw layer is the event journal (`src/infra/event-journal.ts`) plus
 * session JSONL; this module's types describe the *reconstructed* view of a
 * run that the Wiki Maintainer and Skill Proposer consume. Nothing here is
 * written back to the journal — the raw layer is read-only to evolution.
 */

import type { RunOrigin } from "./run-origin.js";

export type TraceStepKind = "assistant" | "tool";

export interface TraceToolStep {
  kind: "tool";
  name: string;
  toolCallId?: string;
  /** JSON-stringified args (redacted, capped downstream). */
  args: string;
  /** Result text (redacted; journal-truncated at 8k chars per block). */
  result: string;
  isError: boolean;
}

export interface TraceAssistantStep {
  kind: "assistant";
  /** Final cumulative text of one assistant streak (redacted). */
  text: string;
}

export type TraceStep = TraceToolStep | TraceAssistantStep;

/**
 * PLAN-44 Phase 0: the journaled user turn — WHAT the run was asked to do.
 * Null for runs recorded before the `user` stream existed.
 */
export interface TraceTask {
  /** Redacted, capped prompt text. */
  text: string;
  /** Original prompt length (before the journal-side cap). */
  chars: number;
  /** Trust class of the author, derived from the session key at read time. */
  origin: RunOrigin;
  isHeartbeat: boolean;
  channel: string | null;
}

export interface ReconstructedTrace {
  runId: string;
  taskId: string | null;
  /** PLAN-44 Phase 0: see TraceTask. */
  task: TraceTask | null;
  sessionKey: string | null;
  startedAt: number | null;
  endedAt: number | null;
  steps: TraceStep[];
  /** lifecycle phase=error was observed. */
  endedWithError: boolean;
  /** Error text from the lifecycle error event, if any. */
  errorText: string | null;
  /** Agent invoked the `complete` tool (weak self-report of success). */
  completedExplicitly: boolean;
  /** Run has a terminal lifecycle event (end or error). */
  isComplete: boolean;
  toolCallCount: number;
  toolErrorCount: number;
  /** Journal seq of the run's last event (cursor bookkeeping). */
  lastSeq: number;
}

/**
 * PLAN-44 Phase 1: `env-fail` = the run failed on the ENVIRONMENT (provider
 * outage, DNS, connection refused, rate limit, 5xx, service unavailable,
 * aborted). Never sampled as an agent failure; may still seed the corpus
 * miner when the task was human-authored.
 */
export type TraceLabel = "pass" | "fail" | "env-fail" | "unknown";

export interface TraceLabelResult {
  label: TraceLabel;
  /** 0..1 confidence in the label. */
  confidence: number;
  /** Which rule or judge produced it. */
  reason: string;
  /** True when an LLM judge produced the final label. */
  judged: boolean;
}

export interface LabeledTrace {
  trace: ReconstructedTrace;
  label: TraceLabelResult;
  /** Formatted, redacted, char-capped log ready for prompt injection. */
  formattedLog: string;
  /**
   * PLAN-44 Phase 1: set when another sampled trace ran the SAME task text
   * with the opposite outcome (contrastive pair). The maintainer is told
   * to compare paired traces first.
   */
  pairId?: string;
}

export interface SamplerStats {
  runsExamined: number;
  runsIncomplete: number;
  runsExcluded: number;
  runsHeldOut: number;
  runsUnknownLabel: number;
  failsSelected: number;
  passesSelected: number;
  judgeCalls: number;
  /** PLAN-44 Phase 0: heartbeat runs skipped (journaled flag). */
  runsHeartbeat: number;
  /** PLAN-44 Phase 0: third-party-origin runs skipped (circle, A2A, subagent, guest). */
  runsUntrustedOrigin: number;
  /** PLAN-44 Phase 0: in-flight runs re-examined from the pending list. */
  pendingReexamined: number;
  /** PLAN-44 Phase 0: runs carrying a journaled task header. */
  runsWithTask: number;
  /** PLAN-44 Phase 1: environment failures seen (excluded from the fail budget). */
  envFails: number;
  /** PLAN-44 (adversarial H1): runs whose task text was flagged by the injection scanner. */
  runsInjected: number;
  /** PLAN-44 Phase 1: candidates skipped as duplicates of an already-selected tool sequence. */
  runsDeduped: number;
  /** PLAN-44 Phase 1: contrastive pairs found among the selected traces. */
  pairs: number;
}

/** PLAN-44 Phase 0: an in-flight run the sampler deferred instead of skipping past. */
export interface PendingRun {
  runId: string;
  firstSeenAt: number;
}

export interface IterationSample {
  samples: LabeledTrace[];
  /** Advance the persistent cursor to this seq after a successful iteration. */
  nextCursorSeq: number;
  stats: SamplerStats;
  /** PLAN-44 Phase 0: in-flight runs to re-examine next iteration. */
  pending: PendingRun[];
  /** PLAN-44 Phase 0: run ids examined this iteration (anti-rescan ring). */
  processedRunIds: string[];
  /**
   * PLAN-44 Phase 1: formatted logs of human-origin env-fail traces. Not
   * maintainer material, but real user tasks that hit outages make good
   * capability-task drafts for the corpus miner.
   */
  envFailTexts: string[];
}
