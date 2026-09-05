/**
 * Long-horizon Task types (PLAN-16 Phase B).
 *
 * A Task is the durable coordination object that lives above a single
 * agent run. It captures the goal, judge-criteria, plan, current
 * progress, and the checkpoint/runId pointers needed to resume after
 * a context-saturation handoff (Phase C) or a crash. Tasks survive
 * gateway restarts; the latest tip is the source of truth for "what
 * is the agent currently doing".
 */

export type TaskStatus =
  | "pending" // created but no execution yet
  | "planning" // a planner pass is in flight or scheduled
  | "running" // agent is actively working on it
  | "waiting_external" // paused awaiting a wakeup (cron, user, external signal)
  | "judging" // worker handed off, Judge verifying done-criteria
  | "completed"
  | "failed"
  | "stopped"; // user-requested termination

export type TaskSource = "user" | "curiosity" | "subagent" | "judge" | "operator";

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export type PlanStep = {
  /** Stable id for the step (e.g. `step-1`). */
  id: string;
  /** Short human-readable title (imperative form). */
  title: string;
  /** Optional richer description / acceptance hint. */
  description?: string;
  status: PlanStepStatus;
  /** Free-form reference to the step's artifact (crystal_id, file path, etc.). */
  output?: string;
};

export type TaskPlan = {
  steps: PlanStep[];
  /** Index into steps[] indicating the active step. */
  cursor?: number;
};

/**
 * A deterministic acceptance check the harness can execute (2026-09-05
 * harness review, B4). See `src/tasks/checks.ts` for semantics and the
 * workspace/command boundaries.
 */
export type TaskCheck =
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; value: string }
  | { kind: "file_regex"; path: string; pattern: string }
  | { kind: "output_regex"; pattern: string }
  | { kind: "command"; command: string; expectExitCode?: number; stdoutRegex?: string };

export type TaskCheckResult = {
  check: TaskCheck;
  description: string;
  passed: boolean;
  detail: string;
};

/**
 * Evidence level behind a verdict (the harness review's L0-L4 hierarchy):
 * 1 = worker self-report only (no judge ran), 2 = independent LLM judge over
 * the recorded output, 3 = deterministic checks executed and passed (plus
 * the judge when criteria go beyond the checks), 4 = a human confirmed the
 * outcome after the fact (recorded by the run-feedback ledger).
 */
export type TaskEvidenceLevel = 1 | 2 | 3 | 4;

export type TaskVerification = {
  verdict: "pass" | "fail" | "needs_more";
  level: TaskEvidenceLevel;
  checks: TaskCheckResult[];
  /** Exact judge model (`provider/model`) or null when no judge call ran. */
  judgeModel: string | null;
  reasoning: string;
  missing: string[];
  round: number;
  at: number;
  /** Run that requested the verification, when known. */
  runId: string | null;
};

export type CheckpointRef = {
  /** Checkpoint store thread id (typically = run id at root). */
  threadId: string;
  /** Checkpoint step id (the tip we'll resume from). */
  stepId: string;
};

export type Task = {
  id: string;
  goal: string;
  doneCriteria: string;
  status: TaskStatus;
  parentTaskId: string | null;
  plan: TaskPlan | null;
  /** Most recent checkpoint tip; resumed-from on wakeup. */
  checkpoint: CheckpointRef | null;
  /** Currently-executing agent run id; null when paused or terminal. */
  currentRunId: string | null;
  /** Final artifact reference (crystal id, file path, etc.). */
  output: string | null;
  /** Deterministic acceptance checks run by the judge pass (may be empty). */
  checks: TaskCheck[];
  /** Latest verification record; `completed` is unreachable without a passing one. */
  verification: TaskVerification | null;
  /** Typed judge-round counter (was model-mutable metadata before B4). */
  judgeRounds: number;
  source: TaskSource;
  /** Cents. Used by Phase E.4 P2P bidding. */
  bounty: number | null;
  /** Session key of the owning agent. */
  agentSessionKey: string | null;
  /** Per-task wakeup count for runaway-loop protection. */
  wakeupCount: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Heartbeat for stall detection. Updated on every status touch. */
  lastSeenAt: number;
  metadata: Record<string, unknown> | null;
};

export type TaskCreateInput = {
  id?: string;
  goal: string;
  doneCriteria: string;
  checks?: TaskCheck[];
  parentTaskId?: string | null;
  plan?: TaskPlan | null;
  source?: TaskSource;
  bounty?: number | null;
  agentSessionKey?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type TaskUpdateInput = {
  goal?: string;
  doneCriteria?: string;
  checks?: TaskCheck[];
  status?: TaskStatus;
  plan?: TaskPlan | null;
  checkpoint?: CheckpointRef | null;
  currentRunId?: string | null;
  output?: string | null;
  source?: TaskSource;
  bounty?: number | null;
  agentSessionKey?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Atomic increment for wakeupCount when scheduling a wakeup. */
  incrementWakeup?: boolean;
};

export type TaskListOptions = {
  status?: TaskStatus | TaskStatus[];
  parentTaskId?: string | null;
  source?: TaskSource;
  limit?: number;
  /** Return only tasks updated since this timestamp (ms epoch). */
  sinceTs?: number;
};

/** Terminal statuses that should not transition further automatically. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * A handoff record: the structured "page of notes" the agent leaves
 * behind when it suspends a task at a context-saturation or rest
 * boundary. The next invocation reads the latest handoff and resumes
 * cold from it (Amp pattern). Held in its own table so handoffs are
 * cheap to write and don't pollute the crystal store.
 */
export type TaskHandoff = {
  id: number;
  taskId: string;
  /** The run that wrote this handoff. Null when written by a non-agent caller. */
  runId: string | null;
  /** Why we're handing off: one or two sentences. */
  intent: string;
  /** Material decisions made so far that the next run must respect. */
  decisions: string[];
  /** What remains, in priority order. */
  pending: string[];
  /** Free-form additional context (tool outputs, findings, citations). */
  context: string | null;
  /** Optional token budget snapshot at the moment of handoff. */
  contextTokens: number | null;
  createdAt: number;
};

export type TaskHandoffInput = {
  taskId: string;
  runId?: string | null;
  intent: string;
  decisions?: string[];
  pending?: string[];
  context?: string | null;
  contextTokens?: number | null;
};
