/**
 * Persistent agent-event journal (PLAN-16 Phase A).
 *
 * Bridges the in-process `onAgentEvent` bus to a SQLite-backed log so
 * every event survives a gateway restart and is replayable via the
 * `task_monitor` tool. Unlike `src/checkpoints/agent-event-writer.ts`,
 * which persists *coarse* boundaries (tool_call / tool_result /
 * lifecycle) as forkable checkpoint rows, this journal captures the
 * **full** event stream tagged with `task_id` so a parent agent or
 * monitor UI can watch a long-horizon task in fine detail.
 *
 * Both writers can run concurrently. The checkpoint writer powers
 * deterministic replay/fork (LangGraph-parity); the journal powers
 * live observation (Claude-Code-parity `Monitor`).
 *
 * Default DB path: `~/.bitterbot/event-journal.sqlite`. Override with
 * `BITTERBOT_EVENT_JOURNAL_DB`. The journal is on by default so that
 * the Task primitive (Phase B) works out of the box; set
 * `BITTERBOT_EVENT_JOURNAL=0` to disable.
 */

import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AgentEventPayload, AgentEventStream } from "./agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveUserPath } from "../utils.js";
import { onAgentEvent } from "./agent-events.js";

const log = createSubsystemLogger("event-journal");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS event_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  task_id     TEXT,
  ts          INTEGER NOT NULL,
  stream      TEXT NOT NULL,
  run_seq     INTEGER NOT NULL,
  session_key TEXT,
  data_blob   BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_run     ON event_log(run_id, run_seq);
CREATE INDEX IF NOT EXISTS idx_event_log_task    ON event_log(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_ts      ON event_log(ts);
`;

export type JournalEvent = {
  /** Journal-global monotonic seq (autoincrement PK). Cursor for since_seq. */
  seq: number;
  runId: string;
  taskId: string | null;
  ts: number;
  stream: AgentEventStream;
  /** Per-run seq (from the original AgentEventPayload). */
  runSeq: number;
  sessionKey: string | null;
  data: Record<string, unknown>;
};

export type QueryOptions = {
  runId?: string;
  taskId?: string;
  /** Return events strictly after this journal seq. */
  sinceSeq?: number;
  /** Filter to specific streams (e.g. ["tool", "assistant"]). */
  streams?: AgentEventStream[];
  /** Max rows to return. Defaults to 1000. */
  limit?: number;
};

export class EventJournal {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
  }

  static open(dbPath: string): EventJournal {
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
    return new EventJournal(db);
  }

  append(evt: AgentEventPayload): void {
    const dataBlob = zlib.gzipSync(JSON.stringify(evt.data ?? {}));
    this.db
      .prepare(
        `INSERT INTO event_log
          (run_id, task_id, ts, stream, run_seq, session_key, data_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evt.runId,
        evt.taskId ?? null,
        evt.ts,
        evt.stream,
        evt.seq,
        evt.sessionKey ?? null,
        dataBlob,
      );
  }

  query(opts: QueryOptions): JournalEvent[] {
    const filters: string[] = [];
    const args: Array<string | number> = [];
    if (opts.runId) {
      filters.push("run_id = ?");
      args.push(opts.runId);
    }
    if (opts.taskId) {
      filters.push("task_id = ?");
      args.push(opts.taskId);
    }
    if (typeof opts.sinceSeq === "number") {
      filters.push("seq > ?");
      args.push(opts.sinceSeq);
    }
    if (opts.streams && opts.streams.length > 0) {
      const placeholders = opts.streams.map(() => "?").join(",");
      filters.push(`stream IN (${placeholders})`);
      for (const s of opts.streams) args.push(s);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const rows = this.db
      .prepare(
        `SELECT seq, run_id, task_id, ts, stream, run_seq, session_key, data_blob
         FROM event_log ${where}
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(...args, limit) as unknown as RawEventRow[];
    return rows.map(rowToEvent);
  }

  /** Latest journal seq across the whole log. Cheap cursor primer. */
  latestSeq(): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS s FROM event_log`).get() as
      | { s: number | null }
      | undefined;
    return row?.s ?? 0;
  }

  /** Count events for a given task. */
  countForTask(taskId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM event_log WHERE task_id = ?`)
      .get(taskId) as { c: number };
    return row.c;
  }

  /** Delete every event for a task. Used on task purge. */
  deleteTask(taskId: string): number {
    const r = this.db.prepare(`DELETE FROM event_log WHERE task_id = ?`).run(taskId);
    return Number(r.changes);
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn(`event journal close error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type RawEventRow = {
  seq: number;
  run_id: string;
  task_id: string | null;
  ts: number;
  stream: string;
  run_seq: number;
  session_key: string | null;
  data_blob: Uint8Array;
};

function rowToEvent(row: RawEventRow): JournalEvent {
  const data = JSON.parse(zlib.gunzipSync(row.data_blob).toString("utf8")) as Record<
    string,
    unknown
  >;
  return {
    seq: row.seq,
    runId: row.run_id,
    taskId: row.task_id,
    ts: row.ts,
    stream: row.stream as AgentEventStream,
    runSeq: row.run_seq,
    sessionKey: row.session_key,
    data,
  };
}

// ---------------------------------------------------------------------------
// Singleton wiring — one journal per process, subscribed to the global bus.
// ---------------------------------------------------------------------------

type JournalState = {
  journal: EventJournal;
  unsubscribe: () => void;
};

let state: JournalState | null = null;

export function isEventJournalEnabled(): boolean {
  const v = process.env.BITTERBOT_EVENT_JOURNAL;
  if (v === undefined) return true; // default ON
  return v === "1" || v === "true";
}

export function defaultEventJournalDbPath(): string {
  return (
    process.env.BITTERBOT_EVENT_JOURNAL_DB ??
    path.join(os.homedir(), ".bitterbot", "event-journal.sqlite")
  );
}

export function startEventJournal(opts?: { dbPath?: string }): EventJournal | null {
  if (state) return state.journal;
  if (!isEventJournalEnabled()) return null;
  const dbPath = opts?.dbPath ?? defaultEventJournalDbPath();
  let journal: EventJournal;
  try {
    journal = EventJournal.open(dbPath);
  } catch (err) {
    log.warn(
      `failed to open event journal at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  const unsubscribe = onAgentEvent((evt) => {
    try {
      journal.append(evt);
    } catch (err) {
      log.warn(`journal append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  state = { journal, unsubscribe };
  log.info(`event journal active dbPath=${dbPath}`);
  return journal;
}

export function stopEventJournal(): void {
  if (!state) return;
  state.unsubscribe();
  state.journal.close();
  state = null;
}

/** Test helper. */
export function getActiveEventJournal(): EventJournal | null {
  return state?.journal ?? null;
}
