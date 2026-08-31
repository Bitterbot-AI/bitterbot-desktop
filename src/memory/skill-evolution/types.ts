/**
 * PLAN-42 skill evolution — shared types for the trace pipeline.
 *
 * The raw layer is the event journal (`src/infra/event-journal.ts`) plus
 * session JSONL; this module's types describe the *reconstructed* view of a
 * run that the Wiki Maintainer and Skill Proposer consume. Nothing here is
 * written back to the journal — the raw layer is read-only to evolution.
 */

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

export interface ReconstructedTrace {
  runId: string;
  taskId: string | null;
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

export type TraceLabel = "pass" | "fail" | "unknown";

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
}

export interface IterationSample {
  samples: LabeledTrace[];
  /** Advance the persistent cursor to this seq after a successful iteration. */
  nextCursorSeq: number;
  stats: SamplerStats;
}
