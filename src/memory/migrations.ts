/**
 * Simple version-based migration runner for the memory database.
 *
 * Reads `schema_version` from the `meta` table and runs migrations
 * sequentially. Each migration is idempotent via ALTER TABLE IF NOT EXISTS
 * and ensureColumn.
 */

import type { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./memory-schema.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory/migrations");

const SCHEMA_VERSION_KEY = "schema_version";

type Migration = {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Knowledge Crystal columns + indexes",
    up: (db: DatabaseSync) => {
      // New crystal metadata columns (all have defaults for backward compat)
      ensureColumn(db, "chunks", "semantic_type", "TEXT DEFAULT 'general'");
      ensureColumn(db, "chunks", "lifecycle", "TEXT DEFAULT 'generated'");
      ensureColumn(db, "chunks", "hormonal_dopamine", "REAL DEFAULT 0");
      ensureColumn(db, "chunks", "hormonal_cortisol", "REAL DEFAULT 0");
      ensureColumn(db, "chunks", "hormonal_oxytocin", "REAL DEFAULT 0");
      ensureColumn(db, "chunks", "governance_json", "TEXT DEFAULT '{}'");
      ensureColumn(db, "chunks", "provenance_chain", "TEXT DEFAULT '[]'");
      ensureColumn(db, "chunks", "created_at", "INTEGER");
      ensureColumn(db, "chunks", "last_consolidated_at", "INTEGER");

      // Migrate existing lifecycle_state values to the new lifecycle column
      db.exec(`
        UPDATE chunks SET lifecycle = CASE
          WHEN COALESCE(lifecycle_state, 'active') = 'active'
               AND COALESCE(memory_type, 'plaintext') = 'skill'
            THEN 'frozen'
          WHEN COALESCE(lifecycle_state, 'active') = 'active'
               AND importance_score >= 0.8
            THEN 'activated'
          WHEN COALESCE(lifecycle_state, 'active') = 'active'
            THEN 'generated'
          WHEN lifecycle_state = 'forgotten'
            THEN 'expired'
          WHEN lifecycle_state = 'archived'
            THEN 'archived'
          WHEN lifecycle_state = 'consolidating'
            THEN 'consolidated'
          ELSE 'generated'
        END
        WHERE lifecycle IS NULL OR lifecycle = 'generated'
      `);

      // Backfill created_at from updated_at where missing
      db.exec(`UPDATE chunks SET created_at = updated_at WHERE created_at IS NULL`);

      // New indexes
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_lifecycle_v2 ON chunks(lifecycle)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_semantic_type ON chunks(semantic_type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_created_at ON chunks(created_at)`);
    },
  },
  {
    version: 2,
    description:
      "Skill execution tracking, peer reputation, versioning, provenance DAG, " +
      "multi-perspective embeddings, marketplace, skill hierarchy, discovery edges, mutation queue",
    up: (db: DatabaseSync) => {
      // ── Phase 3: Skill Execution Tracker ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_executions (
          id TEXT PRIMARY KEY,
          skill_crystal_id TEXT NOT NULL,
          session_id TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          success INTEGER,
          reward_score REAL,
          error_type TEXT,
          error_detail TEXT,
          execution_time_ms INTEGER,
          tool_calls_count INTEGER,
          user_feedback INTEGER,
          context_json TEXT DEFAULT '{}'
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_executions_crystal ON skill_executions(skill_crystal_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_executions_time ON skill_executions(started_at)`);

      // Steering reward on chunks
      ensureColumn(db, "chunks", "steering_reward", "REAL DEFAULT 0");

      // ── Phase 4: Peer Reputation ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS peer_reputation (
          peer_pubkey TEXT PRIMARY KEY,
          peer_id TEXT,
          display_name TEXT,
          skills_received INTEGER DEFAULT 0,
          skills_accepted INTEGER DEFAULT 0,
          skills_rejected INTEGER DEFAULT 0,
          avg_skill_quality REAL DEFAULT 0,
          reputation_score REAL DEFAULT 0.5,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          is_trusted INTEGER DEFAULT 0,
          metadata_json TEXT DEFAULT '{}'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS peer_skill_ratings (
          id TEXT PRIMARY KEY,
          peer_pubkey TEXT NOT NULL,
          skill_crystal_id TEXT NOT NULL,
          rating REAL NOT NULL,
          rated_at INTEGER NOT NULL
        )
      `);

      // ── Phase 5: Provenance DAG ──
      ensureColumn(db, "chunks", "provenance_dag", "TEXT");

      // ── Phase 6: Skill Versioning ──
      ensureColumn(db, "chunks", "stable_skill_id", "TEXT");
      ensureColumn(db, "chunks", "skill_version", "INTEGER DEFAULT 1");
      ensureColumn(db, "chunks", "previous_version_id", "TEXT");
      ensureColumn(db, "chunks", "deprecated", "INTEGER DEFAULT 0");
      ensureColumn(db, "chunks", "deprecated_by", "TEXT");
      ensureColumn(db, "chunks", "skill_tags", "TEXT DEFAULT '[]'");
      ensureColumn(db, "chunks", "skill_category", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_stable_skill ON chunks(stable_skill_id)`);

      // ── Phase 7: Mutation Queue ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS mutation_queue (
          id TEXT PRIMARY KEY,
          skill_crystal_id TEXT NOT NULL,
          strategy TEXT NOT NULL,
          priority REAL DEFAULT 0.5,
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 3,
          last_attempt_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `);

      // ── Phase 8: Multi-Perspective Embeddings ──
      ensureColumn(db, "chunks", "embedding_procedural", "TEXT");
      ensureColumn(db, "chunks", "embedding_causal", "TEXT");
      ensureColumn(db, "chunks", "embedding_entity", "TEXT");

      // ── Phase 9: Marketplace ──
      ensureColumn(db, "chunks", "marketplace_listed", "INTEGER DEFAULT 0");
      ensureColumn(db, "chunks", "marketplace_description", "TEXT");
      ensureColumn(db, "chunks", "download_count", "INTEGER DEFAULT 0");

      // ── Phase 10: Skill Hierarchy ──
      ensureColumn(db, "chunks", "skill_hierarchy", "TEXT");

      // ── Phase 11: Skill Edges (Discovery Agent) ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_edges (
          id TEXT PRIMARY KEY,
          source_skill_id TEXT NOT NULL,
          target_skill_id TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          weight REAL DEFAULT 0.5,
          steering_reward REAL DEFAULT 0,
          confidence REAL DEFAULT 0.5,
          discovered_by TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_edges_source ON skill_edges(source_skill_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_edges_target ON skill_edges(target_skill_id)`);
    },
  },
  {
    version: 3,
    description: "Peer ban/blocklist, EigenTrust trust edges, activity log",
    up: (db: DatabaseSync) => {
      // ── Task 5: Peer ban/blocklist ──
      ensureColumn(db, "peer_reputation", "is_banned", "INTEGER DEFAULT 0");

      // ── Task 6: EigenTrust anti-Sybil ──
      ensureColumn(db, "peer_reputation", "eigentrust_score", "REAL DEFAULT 0.5");
      ensureColumn(db, "peer_reputation", "anomaly_flag", "INTEGER DEFAULT 0");
      ensureColumn(db, "peer_reputation", "last_eigentrust_at", "INTEGER");

      db.exec(`
        CREATE TABLE IF NOT EXISTS peer_trust_edges (
          id TEXT PRIMARY KEY,
          truster_pubkey TEXT NOT NULL,
          trustee_pubkey TEXT NOT NULL,
          trust_weight REAL NOT NULL,
          evidence_count INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(truster_pubkey, trustee_pubkey)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trust_edges_truster ON peer_trust_edges(truster_pubkey)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_trust_edges_trustee ON peer_trust_edges(trustee_pubkey)`);

      db.exec(`
        CREATE TABLE IF NOT EXISTS peer_activity_log (
          id TEXT PRIMARY KEY,
          peer_pubkey TEXT NOT NULL,
          event_type TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_log_peer ON peer_activity_log(peer_pubkey)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_log_time ON peer_activity_log(timestamp)`);
    },
  },
  {
    version: 4,
    description: "Management node verification, bounty tracking",
    up: (db: DatabaseSync) => {
      // Task 2: Verified Safe marketplace tier
      ensureColumn(db, "chunks", "is_verified", "INTEGER DEFAULT 0");
      ensureColumn(db, "chunks", "verified_by", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_verified ON chunks(is_verified)`);

      // Task 4: Bounty tracking
      ensureColumn(db, "chunks", "bounty_match_id", "TEXT");
      ensureColumn(db, "chunks", "bounty_priority_boost", "REAL DEFAULT 0");
    },
  },
  {
    version: 5,
    description: "Skill version conflict resolution — lineage tracking and peer origin",
    up: (db: DatabaseSync) => {
      // Lineage hash uniquely identifies a branch (skill × parent × author)
      ensureColumn(db, "chunks", "lineage_hash", "TEXT");
      // Origin peer pubkey (denormalized from provenance_dag for fast queries)
      ensureColumn(db, "chunks", "peer_origin", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_lineage ON chunks(stable_skill_id, skill_version, lineage_hash)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_peer_origin ON chunks(peer_origin)`);
    },
  },
  {
    version: 6,
    description: "Bitemporal columns for temporal-aware retrieval and fact supersession",
    up: (db: DatabaseSync) => {
      // Valid time: when the fact was true in the real world.
      // NULL valid_time_end means the fact is still current.
      ensureColumn(db, "chunks", "valid_time_start", "INTEGER");
      ensureColumn(db, "chunks", "valid_time_end", "INTEGER");

      // Transaction time: when the agent ingested the information.
      // Distinct from created_at (chunk indexing time) — transaction_time
      // represents when the knowledge entered the system.
      ensureColumn(db, "chunks", "transaction_time", "INTEGER");

      // Backfill from existing timestamps
      db.exec(`
        UPDATE chunks
        SET valid_time_start = COALESCE(created_at, updated_at),
            transaction_time = COALESCE(created_at, updated_at)
        WHERE valid_time_start IS NULL
      `);

      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_valid_time ON chunks(valid_time_start, valid_time_end)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_transaction_time ON chunks(transaction_time)`);
    },
  },
  {
    version: 7,
    description: "Session extraction tracking + epistemic layer for fact stratification",
    up: (db: DatabaseSync) => {
      // Track which sessions have been processed by the extraction pipeline
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_extractions (
          session_path TEXT PRIMARY KEY,
          last_extracted_at INTEGER NOT NULL,
          last_extracted_hash TEXT NOT NULL,
          fact_count INTEGER DEFAULT 0
        )
      `);

      // Epistemic layer: classifies extracted facts into Hindsight-inspired
      // categories (world_fact, experience, mental_model, directive).
      // NULL = legacy/unclassified chunk (not extracted, just indexed).
      ensureColumn(db, "chunks", "epistemic_layer", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_epistemic ON chunks(epistemic_layer)`);
    },
  },
  {
    version: 8,
    description: "Persistent emotional anchors table",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS emotional_anchors (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          description TEXT DEFAULT '',
          dopamine REAL NOT NULL,
          cortisol REAL NOT NULL,
          oxytocin REAL NOT NULL,
          created_at INTEGER NOT NULL,
          recall_count INTEGER DEFAULT 0,
          last_recalled_at INTEGER,
          trigger_event TEXT,
          associated_crystal_ids TEXT
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_emotional_anchors_created ON emotional_anchors(created_at)`);
    },
  },
];

/**
 * Read the current schema version from the meta table.
 */
function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(SCHEMA_VERSION_KEY) as { value: string } | undefined;
    if (!row?.value) return 0;
    const version = parseInt(row.value, 10);
    return Number.isFinite(version) ? version : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the current schema version to the meta table.
 */
function setSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(SCHEMA_VERSION_KEY, String(version));
}

/**
 * Run all pending migrations. Safe to call repeatedly — each migration
 * only runs once per database.
 */
export function runMigrations(db: DatabaseSync): { from: number; to: number; ran: number } {
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current);

  if (pending.length === 0) {
    return { from: current, to: current, ran: 0 };
  }

  pending.sort((a, b) => a.version - b.version);

  let applied = current;
  for (const migration of pending) {
    try {
      log.debug(`running migration v${migration.version}: ${migration.description}`);
      migration.up(db);
      applied = migration.version;
      setSchemaVersion(db, applied);
    } catch (err) {
      log.warn(`migration v${migration.version} failed: ${String(err)}`);
      break;
    }
  }

  const result = { from: current, to: applied, ran: applied - current };
  if (result.ran > 0) {
    log.debug(`migrations complete`, result);
  }
  return result;
}
