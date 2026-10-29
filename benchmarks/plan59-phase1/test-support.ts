/**
 * Synthetic stores for the PLAN-59 Phase 1 tests. No private data: every
 * chunk is generated text with a tiny deterministic embedding.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "../../src/memory/sqlite-vec.js";
import type { Question } from "./common.js";

export const DIMS = 4;

export type SyntheticChunk = {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
  lifecycle?: string;
  lifecycleState?: string;
  parentId?: string | null;
  importance?: number;
  accessCount?: number;
  lastAccessedAt?: number | null;
  createdAt?: number;
  validTimeEnd?: number | null;
  model?: string;
};

export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER,
      importance_score REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      last_accessed_at INTEGER,
      lifecycle TEXT,
      lifecycle_state TEXT,
      parent_id TEXT,
      semantic_type TEXT,
      memory_type TEXT,
      origin TEXT,
      hygiene_done INTEGER DEFAULT 0,
      version INTEGER DEFAULT 1,
      valid_time_end INTEGER
    );
    CREATE TABLE near_merge_hints (
      chunk_id_a TEXT NOT NULL,
      chunk_id_b TEXT NOT NULL,
      base_similarity REAL NOT NULL,
      snn_similarity REAL NOT NULL DEFAULT 0,
      shared_neighbors INTEGER NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL DEFAULT 0,
      consumed_at INTEGER,
      PRIMARY KEY (chunk_id_a, chunk_id_b)
    );
    CREATE TABLE canonical_facts (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      valid_from INTEGER NOT NULL DEFAULT 0,
      valid_until INTEGER,
      superseded_by TEXT,
      evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE memory_audit_log (
      id TEXT PRIMARY KEY,
      chunk_id TEXT,
      event TEXT,
      timestamp INTEGER,
      actor TEXT,
      metadata TEXT
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
      start_line UNINDEXED, end_line UNINDEXED
    );
  `);
}

export const fakeEmbedding = (seed: number): number[] =>
  Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 7 + i) / 2);

export const blob = (vec: number[]): Uint8Array => {
  const f = new Float32Array(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

export function insertChunk(db: DatabaseSync, c: SyntheticChunk, hasVec: boolean): void {
  const text = c.text ?? `synthetic passage for ${c.id} about topic ${c.path}`;
  const start = c.startLine ?? 1;
  const end = c.endLine ?? start + 3;
  db.prepare(
    `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding,
       updated_at, created_at, importance_score, access_count, last_accessed_at, lifecycle,
       lifecycle_state, parent_id, semantic_type, memory_type, origin, valid_time_end)
     VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, 1000, ?, ?, ?, ?, ?, ?, ?, 'fact', 'plaintext', 'indexed', ?)`,
  ).run(
    c.id,
    c.path,
    start,
    end,
    `h_${c.id}`,
    c.model ?? "text-embedding-3-small",
    text,
    blob(fakeEmbedding(text.length)),
    c.createdAt ?? 1000,
    c.importance ?? 0.5,
    c.accessCount ?? 0,
    c.lastAccessedAt ?? null,
    c.lifecycle ?? "generated",
    c.lifecycleState ?? "active",
    c.parentId ?? null,
    c.validTimeEnd ?? null,
  );
  db.prepare(
    `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, 'memory', ?, ?, ?)`,
  ).run(text, c.id, c.path, c.model ?? "text-embedding-3-small", start, end);
  if (hasVec) {
    db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`).run(
      c.id,
      blob(fakeEmbedding(text.length)),
    );
  }
}

export function addHint(db: DatabaseSync, a: string, b: string, sim: number): void {
  db.prepare(
    `INSERT INTO near_merge_hints (chunk_id_a, chunk_id_b, base_similarity) VALUES (?, ?, ?)`,
  ).run(a, b, sim);
}

export type SyntheticStore = {
  db: DatabaseSync;
  path: string;
  hasVec: boolean;
  close: () => void;
};

/** A file-backed synthetic store with the vec0 table when sqlite-vec loads. */
export async function openSyntheticStore(name = "store"): Promise<SyntheticStore> {
  const dir = mkdtempSync(join(tmpdir(), "plan59-test-"));
  const path = join(dir, `${name}.sqlite`);
  const db = new DatabaseSync(path, { allowExtension: true });
  // Test fixture only: every statement outside a transaction would otherwise fsync.
  db.exec("PRAGMA synchronous = OFF");
  const vec = await loadSqliteVecExtension({ db });
  createSchema(db);
  let hasVec = false;
  if (vec.ok) {
    try {
      db.exec(
        `CREATE VIRTUAL TABLE chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${DIMS}])`,
      );
      hasVec = true;
    } catch {
      hasVec = false;
    }
  }
  return { db, path, hasVec, close: () => db.close() };
}

export function question(chunkId: string, path: string, startLine = 1, endLine = 4): Question {
  return { chunkId, path, source: "memory", startLine, endLine, question: `q about ${chunkId}` };
}
