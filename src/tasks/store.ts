/**
 * Task store (PLAN-16 Phase B).
 *
 * Persists long-horizon Task rows in SQLite so the agent's coordination
 * state survives gateway restarts and is queryable from outside the
 * running session. Used by:
 *   - `task_*` agent tools (this file's CRUD surface)
 *   - `LongHorizonRuntime` wrappers in `src/tasks/runtime.ts` (Phase C)
 *   - the Judge subagent (Phase D)
 *   - GCCRF / dream-engine / hormonal integrations (Phase E)
 *
 * Default DB path: `~/.bitterbot/tasks.sqlite`. Override with
 * `BITTERBOT_TASKS_DB`. The store is opened on-demand by the
 * gateway and exposed via `getActiveTaskStore()` for tool callsites.
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CheckpointRef,
  TaskCheck,
  TaskVerification,
  PlanStep,
  Task,
  TaskCreateInput,
  TaskHandoff,
  TaskHandoffInput,
  TaskListOptions,
  TaskPlan,
  TaskSource,
  TaskStatus,
  TaskUpdateInput,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";
import { isTerminal } from "./types.js";

const log = createSubsystemLogger("tasks/store");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                      TEXT PRIMARY KEY,
  goal                    TEXT NOT NULL,
  done_criteria           TEXT NOT NULL,
  status                  TEXT NOT NULL,
  parent_task_id          TEXT,
  plan_json               TEXT,
  checkpoint_thread       TEXT,
  checkpoint_step         TEXT,
  current_run_id          TEXT,
  output_ref              TEXT,
  source                  TEXT NOT NULL,
  bounty                  INTEGER,
  agent_session_key       TEXT,
  wakeup_count            INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  completed_at            INTEGER,
  last_seen_at            INTEGER NOT NULL,
  metadata_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent     ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_last_seen  ON tasks(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_tasks_source     ON tasks(source);

CREATE TABLE IF NOT EXISTS task_handoffs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL,
  run_id          TEXT,
  intent          TEXT NOT NULL,
  decisions_json  TEXT,
  pending_json    TEXT,
  context         TEXT,
  context_tokens  INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_task ON task_handoffs(task_id, created_at);
`;

export type TaskStoreEvent = {
  type: "created" | "updated" | "deleted";
  task: Task;
};

type Listener = (evt: TaskStoreEvent) => void;

/**
 * PLAN-34 Phase 0: auto-spawned curiosity tasks still pending past this
 * horizon are stopped at store open. The horizon mirrors the spawn
 * adapter's own 168h dedupe window: a task the adapter would already
 * re-spawn is abandoned by definition (no executor ever claimed it — the
 * 154-task pile-up swept manually on 2026-07-10).
 */
const AUTOSPAWN_CURIOSITY_SWEEP_MAX_AGE_MS = 168 * 3_600_000;

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<Listener>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
    // 2026-09-05 harness review B4: typed verification columns. Additive,
    // idempotent; pre-B4 rows read back as no checks / no verification.
    ensureColumn(this.db, "tasks", "checks_json", "TEXT");
    ensureColumn(this.db, "tasks", "verification_json", "TEXT");
    ensureColumn(this.db, "tasks", "judge_rounds", "INTEGER NOT NULL DEFAULT 0");
    this.sweepLegacyCuriosityTasks();
  }

  /**
   * B4: a gateway restart kills every in-flight run, but the durable task
   * row still says `running` under a run id that no longer exists (the run
   * registry is in-memory). Called from `startTaskStore`, never from the
   * constructor, so a test can open a store without side effects. Each
   * orphan moves to `waiting_external` with a synthesized handoff so the
   * next wakeup or `task_resume_inline` resumes from real state instead of
   * a phantom. Returns the reconciled task ids.
   */
  reconcileOrphanedRunning(reason = "gateway-restart"): string[] {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status = 'running' OR status = 'judging'`)
      .all() as RawTaskRow[];
    const reconciled: string[] = [];
    for (const row of rows) {
      const task = rowToTask(row);
      try {
        this.writeHandoff({
          taskId: task.id,
          runId: task.currentRunId,
          intent: `Run ${task.currentRunId ?? "(unknown)"} was interrupted (${reason}); the task did not finish.`,
          decisions: [],
          pending: [
            "Resume from the latest handoff and plan; re-verify any step marked in_progress.",
          ],
          context: null,
        });
      } catch (err) {
        log.warn(`reconcile: handoff for ${task.id} failed: ${String(err)}`);
      }
      this.update(task.id, {
        status: "waiting_external",
        currentRunId: null,
        metadata: {
          ...task.metadata,
          stalledReason: reason,
          stalledAt: Date.now(),
          stalledRunId: task.currentRunId,
        },
      });
      reconciled.push(task.id);
    }
    if (reconciled.length > 0) {
      log.warn(`reconciled ${reconciled.length} orphaned running task(s) after ${reason}`);
    }
    return reconciled;
  }

  /**
   * Stop abandoned auto-spawned curiosity tasks older than 168h (PLAN-34
   * Phase 0 containment — the codified, idempotent re-run of the manual
   * 2026-07-10 sweep). Scoped to the maybeSpawnTaskFromCuriosity signature
   * (goal prefix "[curiosity] ", no owning session key) so tool-created
   * curiosity tasks are never touched. Preserves updated_at/last_seen_at —
   * bumping them would push dead rows to the top of task_list ordering and
   * refresh the spawn adapter's dedupe window — and sets completed_at like
   * every other terminal transition. Direct UPDATE, no events: this runs in
   * the constructor before any listener can attach, and the rows are dead
   * weight, not activity. Returns the number of tasks stopped.
   */
  sweepLegacyCuriosityTasks(now = Date.now()): number {
    const cutoff = now - AUTOSPAWN_CURIOSITY_SWEEP_MAX_AGE_MS;
    // Cheap read-only probe first so a routine open never takes a WAL
    // write lock when there is nothing to sweep.
    const pending = this.db
      .prepare(
        `SELECT 1 FROM tasks
         WHERE source = 'curiosity' AND status = 'pending'
           AND agent_session_key IS NULL AND goal LIKE '[curiosity] %'
           AND created_at < ? LIMIT 1`,
      )
      .get(cutoff);
    if (!pending) {
      return 0;
    }
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'stopped', completed_at = ?
         WHERE source = 'curiosity' AND status = 'pending'
           AND agent_session_key IS NULL AND goal LIKE '[curiosity] %'
           AND created_at < ?`,
      )
      .run(now, cutoff);
    const stopped = Number((result as { changes: number | bigint }).changes);
    if (stopped > 0) {
      log.info(`curiosity sweep stopped ${stopped} abandoned auto-spawned task(s) older than 168h`);
    }
    return stopped;
  }

  static open(dbPath: string): TaskStore {
    const resolved = resolveUserPath(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(resolved);
    try {
      db.prepare("PRAGMA journal_mode=WAL").get();
    } catch {
      // older SQLite — fall back to default journal.
    }
    try {
      db.exec("PRAGMA synchronous=NORMAL");
      db.exec("PRAGMA busy_timeout=5000");
    } catch {
      // non-essential.
    }
    return new TaskStore(db);
  }

  /** Subscribe to mutations. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(evt: TaskStoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(evt);
      } catch (err) {
        log.warn(`task store listener error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  create(input: TaskCreateInput): Task {
    const id = input.id ?? generateTaskId();
    const now = Date.now();
    if (input.parentTaskId) {
      const parent = this.get(input.parentTaskId);
      if (!parent) {
        throw new Error(`parent task ${input.parentTaskId} not found`);
      }
    }
    const task: Task = {
      id,
      goal: input.goal,
      doneCriteria: input.doneCriteria,
      status: "pending",
      parentTaskId: input.parentTaskId ?? null,
      plan: input.plan ?? null,
      checkpoint: null,
      currentRunId: null,
      output: null,
      checks: input.checks ?? [],
      verification: null,
      judgeRounds: 0,
      source: input.source ?? "user",
      bounty: input.bounty ?? null,
      agentSessionKey: input.agentSessionKey ?? null,
      wakeupCount: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastSeenAt: now,
      metadata: input.metadata ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks
          (id, goal, done_criteria, status, parent_task_id, plan_json,
           checkpoint_thread, checkpoint_step, current_run_id, output_ref,
           source, bounty, agent_session_key, wakeup_count,
           created_at, updated_at, completed_at, last_seen_at, metadata_json,
           checks_json, verification_json, judge_rounds)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.goal,
        task.doneCriteria,
        task.status,
        task.parentTaskId,
        task.plan ? JSON.stringify(task.plan) : null,
        null,
        null,
        null,
        null,
        task.source,
        task.bounty,
        task.agentSessionKey,
        task.wakeupCount,
        task.createdAt,
        task.updatedAt,
        null,
        task.lastSeenAt,
        task.metadata ? JSON.stringify(task.metadata) : null,
        task.checks.length > 0 ? JSON.stringify(task.checks) : null,
        null,
        0,
      );
    log.info(`task created id=${id} source=${task.source} goal="${truncate(task.goal, 60)}"`);
    this.emit({ type: "created", task });
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
      | RawTaskRow
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /** Look up the latest task associated with a given run id. */
  getByRunId(runId: string): Task | undefined {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE current_run_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(runId) as RawTaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  update(id: string, input: TaskUpdateInput): Task {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`task ${id} not found`);
    }
    if (isTerminal(existing.status) && input.status && input.status !== existing.status) {
      throw new Error(
        `task ${id} is terminal (${existing.status}); cannot transition to ${input.status}`,
      );
    }
    // B4: `completed` is reachable only through recordVerification with a
    // passing verdict. A worker (or anyone else) setting the status directly
    // is refused, loudly, with the path that works.
    if (input.status === "completed" && existing.status !== "completed") {
      throw new Error(
        `task ${id} cannot be marked completed directly; run task_judge (a passing verification is required)`,
      );
    }
    const now = Date.now();
    const next: Task = {
      ...existing,
      goal: input.goal ?? existing.goal,
      doneCriteria: input.doneCriteria ?? existing.doneCriteria,
      checks: input.checks !== undefined ? input.checks : existing.checks,
      status: input.status ?? existing.status,
      plan: input.plan !== undefined ? input.plan : existing.plan,
      checkpoint: input.checkpoint !== undefined ? input.checkpoint : existing.checkpoint,
      currentRunId: input.currentRunId !== undefined ? input.currentRunId : existing.currentRunId,
      output: input.output !== undefined ? input.output : existing.output,
      source: input.source ?? existing.source,
      bounty: input.bounty !== undefined ? input.bounty : existing.bounty,
      agentSessionKey:
        input.agentSessionKey !== undefined ? input.agentSessionKey : existing.agentSessionKey,
      wakeupCount: existing.wakeupCount + (input.incrementWakeup ? 1 : 0),
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      updatedAt: now,
      lastSeenAt: now,
      completedAt:
        input.status && isTerminal(input.status) && !existing.completedAt
          ? now
          : existing.completedAt,
    };
    this.db
      .prepare(
        `UPDATE tasks SET
           goal = ?, done_criteria = ?, status = ?, plan_json = ?,
           checkpoint_thread = ?, checkpoint_step = ?, current_run_id = ?,
           output_ref = ?, source = ?, bounty = ?, agent_session_key = ?,
           wakeup_count = ?, updated_at = ?, completed_at = ?, last_seen_at = ?,
           metadata_json = ?, checks_json = ?
         WHERE id = ?`,
      )
      .run(
        next.goal,
        next.doneCriteria,
        next.status,
        next.plan ? JSON.stringify(next.plan) : null,
        next.checkpoint?.threadId ?? null,
        next.checkpoint?.stepId ?? null,
        next.currentRunId,
        next.output,
        next.source,
        next.bounty,
        next.agentSessionKey,
        next.wakeupCount,
        next.updatedAt,
        next.completedAt,
        next.lastSeenAt,
        next.metadata ? JSON.stringify(next.metadata) : null,
        next.checks.length > 0 ? JSON.stringify(next.checks) : null,
        id,
      );
    this.emit({ type: "updated", task: next });
    return next;
  }

  /**
   * B4: the ONLY path to `completed`. Persists the verification record and
   * the typed round counter, then applies the status the caller derived
   * from the verdict. A `completed` status with a non-passing verdict is
   * refused (the verdict and the transition must agree).
   */
  recordVerification(id: string, verification: TaskVerification, nextStatus: TaskStatus): Task {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`task ${id} not found`);
    }
    if (isTerminal(existing.status)) {
      throw new Error(`task ${id} is terminal (${existing.status}); cannot record a verification`);
    }
    if (nextStatus === "completed" && verification.verdict !== "pass") {
      throw new Error(
        `task ${id}: completed requires a passing verification (got ${verification.verdict})`,
      );
    }
    const now = Date.now();
    const rounds = existing.judgeRounds + 1;
    const record: TaskVerification = { ...verification, round: rounds, at: now };
    const completedAt =
      isTerminal(nextStatus) && !existing.completedAt ? now : existing.completedAt;
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, verification_json = ?, judge_rounds = ?,
           updated_at = ?, completed_at = ?, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(nextStatus, JSON.stringify(record), rounds, now, completedAt, now, id);
    const next: Task = {
      ...existing,
      status: nextStatus,
      verification: record,
      judgeRounds: rounds,
      updatedAt: now,
      completedAt,
      lastSeenAt: now,
    };
    this.emit({ type: "updated", task: next });
    return next;
  }

  // -------------------------------------------------------------------------
  // Per-task workspace: durable machine-readable state (variables, artifact
  // paths, handles) that survives handoffs, wakeups, and compaction. Rides in
  // metadata.workspace with merge semantics so concurrent metadata writers
  // that spread `existing.metadata` don't clobber it.
  // -------------------------------------------------------------------------

  static readonly WORKSPACE_KEY = "workspace";
  static readonly WORKSPACE_MAX_BYTES = 65_536;

  /** Read the per-task workspace ({} when unset). Throws if the task is missing. */
  getWorkspace(id: string): Record<string, unknown> {
    const task = this.get(id);
    if (!task) {
      throw new Error(`task ${id} not found`);
    }
    const ws = task.metadata?.[TaskStore.WORKSPACE_KEY];
    return ws && typeof ws === "object" && !Array.isArray(ws)
      ? (ws as Record<string, unknown>)
      : {};
  }

  /**
   * Merge entries into the per-task workspace. A null value deletes its key.
   * Read-modify-write on the whole metadata object so other metadata keys
   * are preserved. Enforces a serialized-size cap to prevent workspace bloat.
   */
  mergeWorkspace(id: string, patch: Record<string, unknown>): Task {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`task ${id} not found`);
    }
    const current = this.getWorkspace(id);
    const workspace: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new Error(`workspace key "${key}" is not allowed`);
      }
      if (value === null) {
        delete workspace[key];
      } else {
        workspace[key] = value;
      }
    }
    const serialized = JSON.stringify(workspace);
    if (serialized.length > TaskStore.WORKSPACE_MAX_BYTES) {
      throw new Error(
        `workspace for task ${id} would exceed ${TaskStore.WORKSPACE_MAX_BYTES} bytes ` +
          `(${serialized.length}); store large artifacts as files and keep paths here`,
      );
    }
    return this.update(id, {
      metadata: { ...existing.metadata, [TaskStore.WORKSPACE_KEY]: workspace },
    });
  }

  /** Atomic plan-step mutation; bumps lastSeen + cursor. */
  setStepStatus(id: string, stepId: string, status: PlanStep["status"], output?: string): Task {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`task ${id} not found`);
    }
    if (!existing.plan) {
      throw new Error(`task ${id} has no plan`);
    }
    const idx = existing.plan.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) {
      throw new Error(`step ${stepId} not found in task ${id}`);
    }
    const steps = existing.plan.steps.slice();
    steps[idx] = {
      ...steps[idx],
      status,
      ...(output !== undefined ? { output } : {}),
    };
    const cursor = nextCursor(steps);
    return this.update(id, { plan: { steps, cursor } });
  }

  list(opts: TaskListOptions = {}): Task[] {
    const filters: string[] = [];
    const args: Array<string | number> = [];
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      const placeholders = statuses.map(() => "?").join(",");
      filters.push(`status IN (${placeholders})`);
      for (const s of statuses) args.push(s);
    }
    if (opts.parentTaskId !== undefined) {
      if (opts.parentTaskId === null) {
        filters.push(`parent_task_id IS NULL`);
      } else {
        filters.push(`parent_task_id = ?`);
        args.push(opts.parentTaskId);
      }
    }
    if (opts.source) {
      filters.push(`source = ?`);
      args.push(opts.source);
    }
    if (typeof opts.sinceTs === "number") {
      filters.push(`updated_at >= ?`);
      args.push(opts.sinceTs);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args, limit) as RawTaskRow[];
    return rows.map(rowToTask);
  }

  /** Hard delete; used by tests and operator-driven purges. */
  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const r = this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    if (r.changes > 0) {
      this.emit({ type: "deleted", task: existing });
      return true;
    }
    return false;
  }

  count(opts: { status?: TaskStatus | TaskStatus[] } = {}): number {
    const filters: string[] = [];
    const args: string[] = [];
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      const placeholders = statuses.map(() => "?").join(",");
      filters.push(`status IN (${placeholders})`);
      for (const s of statuses) args.push(s);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM tasks ${where}`).get(...args) as {
      c: number;
    };
    return row.c;
  }

  // -------------------------------------------------------------------------
  // Handoffs (PLAN-16 Phase C). Structured "page of notes" the worker
  // leaves behind on suspend/wakeup boundaries. The next invocation reads
  // the latest handoff and resumes cold from it instead of relying on
  // in-context summarization.
  // -------------------------------------------------------------------------

  writeHandoff(input: TaskHandoffInput): TaskHandoff {
    if (!this.get(input.taskId)) {
      throw new Error(`task ${input.taskId} not found`);
    }
    const createdAt = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO task_handoffs
          (task_id, run_id, intent, decisions_json, pending_json, context, context_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.runId ?? null,
        input.intent,
        input.decisions ? JSON.stringify(input.decisions) : null,
        input.pending ? JSON.stringify(input.pending) : null,
        input.context ?? null,
        input.contextTokens ?? null,
        createdAt,
      );
    log.info(`task handoff written task=${input.taskId} id=${Number(result.lastInsertRowid)}`);
    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId,
      runId: input.runId ?? null,
      intent: input.intent,
      decisions: input.decisions ?? [],
      pending: input.pending ?? [],
      context: input.context ?? null,
      contextTokens: input.contextTokens ?? null,
      createdAt,
    };
  }

  latestHandoff(taskId: string): TaskHandoff | undefined {
    const row = this.db
      .prepare(
        `SELECT id, task_id, run_id, intent, decisions_json, pending_json,
                context, context_tokens, created_at
         FROM task_handoffs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as RawHandoffRow | undefined;
    return row ? rowToHandoff(row) : undefined;
  }

  listHandoffs(taskId: string, limit = 50): TaskHandoff[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, run_id, intent, decisions_json, pending_json,
                context, context_tokens, created_at
         FROM task_handoffs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, Math.max(1, Math.min(limit, 500))) as RawHandoffRow[];
    return rows.map(rowToHandoff);
  }

  countHandoffs(taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM task_handoffs WHERE task_id = ?`)
      .get(taskId) as { c: number };
    return row.c;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn(`task store close error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type RawHandoffRow = {
  id: number;
  task_id: string;
  run_id: string | null;
  intent: string;
  decisions_json: string | null;
  pending_json: string | null;
  context: string | null;
  context_tokens: number | null;
  created_at: number;
};

function rowToHandoff(row: RawHandoffRow): TaskHandoff {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    intent: row.intent,
    decisions: row.decisions_json ? (JSON.parse(row.decisions_json) as string[]) : [],
    pending: row.pending_json ? (JSON.parse(row.pending_json) as string[]) : [],
    context: row.context,
    contextTokens: row.context_tokens,
    createdAt: row.created_at,
  };
}

type RawTaskRow = {
  id: string;
  goal: string;
  done_criteria: string;
  status: string;
  parent_task_id: string | null;
  plan_json: string | null;
  checkpoint_thread: string | null;
  checkpoint_step: string | null;
  current_run_id: string | null;
  output_ref: string | null;
  source: string;
  bounty: number | null;
  agent_session_key: string | null;
  wakeup_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_seen_at: number;
  metadata_json: string | null;
  checks_json?: string | null;
  verification_json?: string | null;
  judge_rounds?: number | null;
};

function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: RawTaskRow): Task {
  const checkpoint: CheckpointRef | null =
    row.checkpoint_thread && row.checkpoint_step
      ? { threadId: row.checkpoint_thread, stepId: row.checkpoint_step }
      : null;
  return {
    id: row.id,
    goal: row.goal,
    doneCriteria: row.done_criteria,
    status: row.status as TaskStatus,
    parentTaskId: row.parent_task_id,
    plan: row.plan_json ? (JSON.parse(row.plan_json) as TaskPlan) : null,
    checkpoint,
    currentRunId: row.current_run_id,
    output: row.output_ref,
    checks: parseJsonOr<TaskCheck[]>(row.checks_json, []),
    verification: parseJsonOr<TaskVerification | null>(row.verification_json, null),
    judgeRounds: typeof row.judge_rounds === "number" ? row.judge_rounds : 0,
    source: row.source as TaskSource,
    bounty: row.bounty,
    agentSessionKey: row.agent_session_key,
    wakeupCount: row.wakeup_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    lastSeenAt: row.last_seen_at,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
  };
}

function generateTaskId(): string {
  const t = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `task-${t}-${rand}`;
}

function nextCursor(steps: PlanStep[]): number | undefined {
  const idx = steps.findIndex((s) => s.status === "in_progress" || s.status === "pending");
  return idx >= 0 ? idx : undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// ---------------------------------------------------------------------------
// Singleton wiring.
// ---------------------------------------------------------------------------

let active: TaskStore | null = null;

export function defaultTaskStoreDbPath(): string {
  return process.env.BITTERBOT_TASKS_DB ?? path.join(os.homedir(), ".bitterbot", "tasks.sqlite");
}

export function startTaskStore(opts?: { dbPath?: string }): TaskStore | null {
  if (active) return active;
  const dbPath = opts?.dbPath ?? defaultTaskStoreDbPath();
  try {
    active = TaskStore.open(dbPath);
    log.info(`task store active dbPath=${dbPath}`);
    try {
      active.reconcileOrphanedRunning();
    } catch (err) {
      log.warn(`task store reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return active;
  } catch (err) {
    log.warn(
      `failed to open task store at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function stopTaskStore(): void {
  if (!active) return;
  active.close();
  active = null;
}

export function getActiveTaskStore(): TaskStore | null {
  return active;
}
