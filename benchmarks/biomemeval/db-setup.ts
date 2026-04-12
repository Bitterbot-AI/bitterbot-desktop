/**
 * BioMemEval database setup: creates an in-memory SQLite database
 * with the full Bitterbot schema including all PLAN-9 tables.
 */

import { DatabaseSync } from "node:sqlite";
import { ensureDreamSchema } from "../../src/memory/dream-schema.js";
import { ensureMemoryIndexSchema, ensureColumn } from "../../src/memory/memory-schema.js";

export function createBenchmarkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");

  ensureMemoryIndexSchema({
    db,
    embeddingCacheTable: "embedding_cache",
    ftsTable: "chunks_fts",
    ftsEnabled: false,
  });

  ensureDreamSchema(db);

  // Ensure all columns that feature modules expect
  ensureColumn(db, "chunks", "lifecycle", "TEXT DEFAULT 'generated'");
  ensureColumn(db, "chunks", "semantic_type", "TEXT DEFAULT 'general'");
  ensureColumn(db, "chunks", "created_at", "INTEGER");
  ensureColumn(db, "chunks", "last_consolidated_at", "INTEGER");
  ensureColumn(db, "chunks", "steering_reward", "REAL DEFAULT 0");
  ensureColumn(db, "chunks", "labile_until", "INTEGER");
  ensureColumn(db, "chunks", "reconsolidation_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "chunks", "open_loop", "INTEGER DEFAULT 0");
  ensureColumn(db, "chunks", "open_loop_context", "TEXT");
  ensureColumn(db, "chunks", "captured_by", "TEXT");
  ensureColumn(db, "chunks", "access_timestamps", "TEXT DEFAULT '[]'");
  ensureColumn(db, "chunks", "spacing_score", "REAL DEFAULT 0");
  ensureColumn(db, "chunks", "hormonal_dopamine", "REAL DEFAULT 0");
  ensureColumn(db, "chunks", "hormonal_cortisol", "REAL DEFAULT 0");
  ensureColumn(db, "chunks", "hormonal_oxytocin", "REAL DEFAULT 0");

  // Knowledge Graph tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      properties TEXT DEFAULT '{}',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      mention_count INTEGER DEFAULT 1,
      importance REAL DEFAULT 0.5
    )
  `);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities(name, entity_type)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      valid_from INTEGER,
      valid_until INTEGER,
      evidence_chunk_ids TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_entity_id)`);

  // Prospective memories table
  db.exec(`
    CREATE TABLE IF NOT EXISTS prospective_memories (
      id TEXT PRIMARY KEY,
      trigger_condition TEXT NOT NULL,
      trigger_embedding TEXT,
      action TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      triggered_at INTEGER,
      source_session TEXT,
      priority REAL DEFAULT 0.5
    )
  `);

  // Epistemic directives table
  db.exec(`
    CREATE TABLE IF NOT EXISTS epistemic_directives (
      id TEXT PRIMARY KEY,
      directive_type TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT,
      priority REAL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolution TEXT,
      source_entity_ids TEXT DEFAULT '[]',
      attempts INTEGER DEFAULT 0
    )
  `);

  return db;
}
