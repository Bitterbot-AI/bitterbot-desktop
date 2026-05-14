// Cron job data model. The on-disk shape and the Gateway/CLI shapes are kept
// canonical here so every layer agrees. Legacy callers that send `id` instead
// of `jobId` are normalised at the RPC boundary; everything internal uses
// `jobId`.

export type CronScheduleAt = { kind: "at"; at: string };
export type CronScheduleEvery = { kind: "every"; everyMs: number };
export type CronScheduleCron = { kind: "cron"; expr: string; tz?: string };
export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "now" | "next-heartbeat";

export type CronPayloadSystemEvent = {
  kind: "systemEvent";
  text: string;
};
export type CronPayloadAgentTurn = {
  kind: "agentTurn";
  message: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  /**
   * PLAN-16 Phase C: when set, the agent invocation triggered by this
   * job is correlated to a long-horizon Task. The receiving runner
   * tags emitted events with `taskId` so `task_monitor` can stream the
   * full lifecycle. Set automatically by `task_schedule_wakeup`.
   */
  taskId?: string;
  /**
   * PLAN-16 Phase C: handoff id (from `task_handoffs.id`) the woken
   * agent should read on entry. Surfaced in the agent's prompt so the
   * model knows to invoke `task_read_handoff` and rebuild context cold
   * from the structured handoff rather than carrying compaction state.
   */
  handoffId?: number;
  /**
   * PLAN-16 Phase C: checkpoint ref the runner should consult when
   * rebuilding state. Used for fine-grained replay; the handoff is the
   * coarse-grained source of truth.
   */
  resumeFromCheckpoint?: { threadId: string; stepId: string };
};
export type CronPayload = CronPayloadSystemEvent | CronPayloadAgentTurn;

export type CronDeliveryMode = "announce" | "none";
export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: string;
  to?: string;
  bestEffort?: boolean;
};

export type CronJob = {
  jobId: string;
  name?: string;
  description?: string;
  enabled: boolean;
  agentId?: string;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  delivery?: CronDelivery;
  notify?: boolean;
  deleteAfterRun?: boolean;
  consecutiveErrors: number;
  lastRunAt?: number;
  lastRunStatus?: CronRunStatus;
  nextRunAt?: number;
  retryUntilMs?: number;
  createdAt: number;
  updatedAt: number;
};

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronRun = {
  ts: number;
  jobId: string;
  status: CronRunStatus;
  durationMs?: number;
  error?: string;
  trigger?: "schedule" | "manual" | "manual-due";
};

// Wire shape used by the Control UI cron-store. Kept compatible with the
// old/legacy field names (`id`, `label`, `schedule` as a string, `text`).
// The RPC layer is responsible for converting between this and CronJob.
export type CronJobWire = {
  id: string;
  label?: string;
  schedule: string;
  text: string;
  enabled: boolean;
  sessionKey?: string;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt?: number;
  updatedAt?: number;
  // Canonical fields are also exposed so newer clients can consume them.
  jobId?: string;
  name?: string;
  description?: string;
  agentId?: string;
  sessionTarget?: CronSessionTarget;
  wakeMode?: CronWakeMode;
  payload?: CronPayload;
  delivery?: CronDelivery;
  notify?: boolean;
  deleteAfterRun?: boolean;
  consecutiveErrors?: number;
  lastRunStatus?: CronRunStatus;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronEngineStatus = {
  enabled: boolean;
  running: boolean;
  storePath: string;
  jobs: number;
  enabledJobs: number;
  inFlight: number;
  maxConcurrentRuns: number;
  webhookConfigured: boolean;
  /** Earliest `nextRunAt` across all enabled jobs (ms epoch), or null if idle. */
  nextWakeAtMs: number | null;
};
