import type { DatabaseSync } from "node:sqlite";
import type { A2aArtifact, A2aMessage, A2aTaskState } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function ensureA2aSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id TEXT PRIMARY KEY,
      context_id TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      session_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES a2a_tasks(id),
      role TEXT NOT NULL,
      parts TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS a2a_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES a2a_tasks(id),
      name TEXT,
      description TEXT,
      parts TEXT NOT NULL,
      artifact_index INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status ON a2a_tasks(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_a2a_messages_task ON a2a_messages(task_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_task ON a2a_artifacts(task_id);`);
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string;
  context_id: string | null;
  status: string;
  session_key: string | null;
  created_at: number;
  updated_at: number;
  metadata: string | null;
};

type MessageRow = {
  id: string;
  task_id: string;
  role: string;
  parts: string;
  metadata: string | null;
  created_at: number;
};

type ArtifactRow = {
  id: string;
  task_id: string;
  name: string | null;
  description: string | null;
  parts: string;
  artifact_index: number;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class A2aTaskStore {
  constructor(private readonly db: DatabaseSync) {}

  createTask(params: {
    id: string;
    contextId?: string;
    sessionKey?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO a2a_tasks (id, context_id, status, session_key, created_at, updated_at, metadata)
         VALUES (?, ?, 'submitted', ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.contextId ?? null,
        params.sessionKey ?? null,
        now,
        now,
        params.metadata ? JSON.stringify(params.metadata) : null,
      );
  }

  updateTaskStatus(taskId: string, status: A2aTaskState): void {
    this.db
      .prepare(`UPDATE a2a_tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), taskId);
  }

  updateTaskSessionKey(taskId: string, sessionKey: string): void {
    this.db
      .prepare(`UPDATE a2a_tasks SET session_key = ?, updated_at = ? WHERE id = ?`)
      .run(sessionKey, Date.now(), taskId);
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM a2a_tasks WHERE id = ?`).get(taskId) as
      | TaskRow
      | undefined;
  }

  listTasks(params?: {
    contextId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): TaskRow[] {
    const conditions: string[] = [];
    const args: (string | number)[] = [];

    if (params?.contextId) {
      conditions.push("context_id = ?");
      args.push(params.contextId);
    }
    if (params?.status) {
      conditions.push("status = ?");
      args.push(params.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    return this.db
      .prepare(`SELECT * FROM a2a_tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as TaskRow[];
  }

  addMessage(params: {
    id: string;
    taskId: string;
    role: "user" | "agent";
    parts: unknown[];
    metadata?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO a2a_messages (id, task_id, role, parts, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.taskId,
        params.role,
        JSON.stringify(params.parts),
        params.metadata ? JSON.stringify(params.metadata) : null,
        Date.now(),
      );
  }

  getMessages(taskId: string, limit?: number): A2aMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_messages WHERE task_id = ? ORDER BY created_at ASC${limit ? ` LIMIT ${limit}` : ""}`,
      )
      .all(taskId) as MessageRow[];

    return rows.map((row) => ({
      role: row.role as "user" | "agent",
      parts: JSON.parse(row.parts),
      ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
    }));
  }

  addArtifact(params: {
    id: string;
    taskId: string;
    name?: string;
    description?: string;
    parts: unknown[];
    index?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO a2a_artifacts (id, task_id, name, description, parts, artifact_index, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.taskId,
        params.name ?? null,
        params.description ?? null,
        JSON.stringify(params.parts),
        params.index ?? 0,
        Date.now(),
      );
  }

  getArtifacts(taskId: string): A2aArtifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_artifacts WHERE task_id = ? ORDER BY artifact_index ASC, created_at ASC`,
      )
      .all(taskId) as ArtifactRow[];

    return rows.map((row) => ({
      name: row.name ?? undefined,
      description: row.description ?? undefined,
      parts: JSON.parse(row.parts),
      index: row.artifact_index,
    }));
  }

  deleteTask(taskId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM a2a_artifacts WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM a2a_messages WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM a2a_tasks WHERE id = ?`).run(taskId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
