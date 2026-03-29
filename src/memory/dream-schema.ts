/**
 * Dream Engine schema: dream_insights and dream_cycles tables,
 * plus chunk-level columns for dream tracking and neuroscience harvest tables
 * (telemetry, near-merge hints, orphan replay queue).
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./memory-schema.js";

/**
 * Shared telemetry writer for dream engine and consolidation phases.
 * Standalone function so both DreamEngine and ConsolidationEngine can use it
 * without coupling to each other.
 */
export function recordDreamTelemetry(
  db: DatabaseSync,
  cycleId: string,
  phase: string,
  metric: string,
  value: number,
): void {
  try {
    db.prepare(
      `INSERT INTO dream_telemetry (cycle_id, phase, metric_name, metric_value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(cycleId, phase, metric, value, Date.now());
  } catch {
    // Table may not exist yet during early init — non-critical
  }
}

export function ensureDreamSchema(db: DatabaseSync): void {
  // Ensure chunks table has curiosity_reward column (used by selectSeeds ORDER BY).
  // This column is also created by gccrf-state.ts, but the dream engine needs it
  // independently since it queries it in seed selection.
  ensureColumn(db, "chunks", "curiosity_reward", "REAL DEFAULT NULL");

  // Ripple-timing replay tracking (Phase 2)
  ensureColumn(db, "chunks", "last_ripple_count", "INTEGER DEFAULT NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_insights (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.0,
      mode TEXT NOT NULL DEFAULT 'associative',
      source_chunk_ids TEXT NOT NULL DEFAULT '[]',
      source_cluster_ids TEXT NOT NULL DEFAULT '[]',
      dream_cycle_id TEXT NOT NULL,
      importance_score REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_cycles (
      cycle_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      state TEXT NOT NULL DEFAULT 'DORMANT',
      clusters_processed INTEGER NOT NULL DEFAULT 0,
      insights_generated INTEGER NOT NULL DEFAULT 0,
      chunks_analyzed INTEGER NOT NULL DEFAULT 0,
      llm_calls_used INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
  `);

  // Dream telemetry: closed-loop validation for neuroscience harvest phases
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_telemetry (
      cycle_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_dream_telemetry_cycle ON dream_telemetry(cycle_id);`,
  );

  // SNN near-merge hints: discovered by consolidation, consumed by compression mode
  db.exec(`
    CREATE TABLE IF NOT EXISTS near_merge_hints (
      chunk_id_a TEXT NOT NULL,
      chunk_id_b TEXT NOT NULL,
      base_similarity REAL NOT NULL,
      snn_similarity REAL NOT NULL,
      shared_neighbors INTEGER NOT NULL,
      discovered_at INTEGER NOT NULL,
      consumed_at INTEGER,
      PRIMARY KEY (chunk_id_a, chunk_id_b)
    );
  `);

  // Orphan replay queue: detected by consolidation, consumed by replay mode
  db.exec(`
    CREATE TABLE IF NOT EXISTS orphan_replay_queue (
      chunk_id TEXT PRIMARY KEY,
      cluster_importance REAL NOT NULL,
      cluster_size INTEGER NOT NULL,
      queued_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `);

  // Dream outcome evaluation: closed-loop feedback for dream quality (Plan 7, Phase 5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS dream_outcomes (
      cycle_id TEXT PRIMARY KEY,
      dqs REAL NOT NULL,
      crystal_yield REAL NOT NULL,
      merge_efficiency REAL NOT NULL,
      orphan_rescue REAL NOT NULL,
      bond_stability REAL NOT NULL,
      token_efficiency REAL NOT NULL,
      fsho_r REAL,
      curiosity_targets INTEGER,
      gccrf_maturity REAL,
      readiness_score REAL,
      modes_run TEXT,
      timestamp INTEGER NOT NULL
    );
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_dream_insights_cycle ON dream_insights(dream_cycle_id);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_dream_insights_importance ON dream_insights(importance_score);`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_dream_cycles_started ON dream_cycles(started_at);`,
  );
}
