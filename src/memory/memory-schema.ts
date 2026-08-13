import type { DatabaseSync } from "node:sqlite";
import { ensureCuriositySchema } from "./curiosity-schema.js";
import { ensureDreamSchema } from "./dream-schema.js";
import { runMigrations } from "./migrations.js";

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string; ftsBackfilled?: number } {
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  // Self-healing FTS backfill: chunks written outside the embedding sync path
  // (scratch crystals, migrations, rebuilds that cleared the FTS table) never
  // got FTS rows, silently killing keyword recall. Re-insert any chunk the
  // FTS table is missing. Idempotent and cheap when the tables are in sync.
  let ftsBackfilled = 0;
  if (ftsAvailable) {
    try {
      const before = (
        params.db.prepare(`SELECT count(*) AS c FROM ${params.ftsTable}`).get() as { c: number }
      ).c;
      // ...but NOT chunks that were deliberately removed from the search
      // surface. The PLAN-40 hygiene merge demotes near-duplicates by deleting
      // their FTS/vec rows — that deletion IS the merge. This backfill has no
      // way to tell "never indexed" from "deliberately de-indexed", so without
      // the lifecycle fence it resurrected every demoted member on the next
      // ensureSchema (boot, sync, or db swap), which is why all 18 demoted
      // members were found sitting in chunks_fts beside their summary. The
      // merge could not have worked on any node, ever. (2026-08-12)
      params.db.exec(
        `INSERT INTO ${params.ftsTable} (text, id, path, source, model, start_line, end_line)
         SELECT c.text, c.id, c.path, c.source, c.model, c.start_line, c.end_line
         FROM chunks c
         WHERE c.id NOT IN (SELECT id FROM ${params.ftsTable})
           AND COALESCE(c.lifecycle, 'generated') NOT IN ('consolidated', 'archived')`,
      );
      const after = (
        params.db.prepare(`SELECT count(*) AS c FROM ${params.ftsTable}`).get() as { c: number }
      ).c;
      ftsBackfilled = after - before;
    } catch {
      // Backfill is best-effort; search still works via the vector lane
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "importance_score", "REAL DEFAULT 1.0");
  ensureColumn(params.db, "chunks", "access_count", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "last_accessed_at", "INTEGER");

  // MemCube lifecycle columns
  ensureColumn(params.db, "chunks", "lifecycle_state", "TEXT DEFAULT 'active'");
  ensureColumn(params.db, "chunks", "memory_type", "TEXT DEFAULT 'plaintext'");
  ensureColumn(params.db, "chunks", "origin", "TEXT DEFAULT 'indexed'");
  ensureColumn(params.db, "chunks", "emotional_valence", "REAL");
  ensureColumn(params.db, "chunks", "curiosity_boost", "REAL DEFAULT 0.0");
  ensureColumn(params.db, "chunks", "dream_count", "INTEGER DEFAULT 0");
  ensureColumn(params.db, "chunks", "last_dreamed_at", "INTEGER");
  ensureColumn(params.db, "chunks", "version", "INTEGER DEFAULT 1");
  ensureColumn(params.db, "chunks", "parent_id", "TEXT");

  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_importance ON chunks(importance_score);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_lifecycle ON chunks(lifecycle_state);`);

  // Memory audit log
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id TEXT PRIMARY KEY,
      chunk_id TEXT,
      event TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      metadata TEXT DEFAULT '{}'
    );
  `);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_chunk ON memory_audit_log(chunk_id);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON memory_audit_log(timestamp);`);

  // Dream and Curiosity schemas
  ensureDreamSchema(params.db);
  ensureCuriositySchema(params.db);

  // Knowledge Crystal migrations (versioned, idempotent)
  runMigrations(params.db);

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}), ftsBackfilled };
}

export function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
