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

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<Listener>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
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
           created_at, updated_at, completed_at, last_seen_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    const now = Date.now();
    const next: Task = {
      ...existing,
      goal: input.goal ?? existing.goal,
      doneCriteria: input.doneCriteria ?? existing.doneCriteria,
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
           metadata_json = ?
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
        id,
      );
    this.emit({ type: "updated", task: next });
    return next;
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
};

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
