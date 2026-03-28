/**
 * Curiosity Engine schema: knowledge regions, query history, exploration
 * targets, surprise assessments, and learning progress tracking.
 */

import type { DatabaseSync } from "node:sqlite";

export function ensureCuriositySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_regions (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      centroid TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      total_accesses INTEGER NOT NULL DEFAULT 0,
      mean_importance REAL NOT NULL DEFAULT 0.0,
      prediction_error REAL NOT NULL DEFAULT 0.0,
      learning_progress REAL NOT NULL DEFAULT 0.0,
      created_at INTEGER NOT NULL,
      last_updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_queries (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      query_embedding TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      top_score REAL NOT NULL DEFAULT 0.0,
      mean_score REAL NOT NULL DEFAULT 0.0,
      region_id TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_targets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      priority REAL NOT NULL DEFAULT 0.0,
      region_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      expires_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_surprises (
      chunk_id TEXT PRIMARY KEY,
      novelty_score REAL NOT NULL DEFAULT 0.0,
      surprise_factor REAL NOT NULL DEFAULT 0.0,
      information_gain REAL NOT NULL DEFAULT 0.0,
      contradiction_score REAL NOT NULL DEFAULT 0.0,
      composite_reward REAL NOT NULL DEFAULT 0.0,
      region_id TEXT,
      assessed_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_progress (
      id TEXT PRIMARY KEY,
      region_id TEXT NOT NULL,
      prediction_error REAL NOT NULL DEFAULT 0.0,
      timestamp INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS curiosity_emergence (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      involved_regions TEXT NOT NULL DEFAULT '[]',
      strength REAL NOT NULL DEFAULT 0.0,
      detected_at INTEGER NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_emergence_detected ON curiosity_emergence(detected_at);`,
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_queries_ts ON curiosity_queries(timestamp);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_targets_type ON curiosity_targets(type);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_targets_expires ON curiosity_targets(expires_at);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_progress_region ON curiosity_progress(region_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_queries_region ON curiosity_queries(region_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_surprises_region ON curiosity_surprises(region_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_curiosity_surprises_assessed ON curiosity_surprises(assessed_at);`,
  );
}
