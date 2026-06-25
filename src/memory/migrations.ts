/**
 * Simple version-based migration runner for the memory database.
 *
 * Reads `schema_version` from the `meta` table and runs migrations
 * sequentially. Each migration is idempotent via ALTER TABLE IF NOT EXISTS
 * and ensureColumn.
 */

import type { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ensureColumn } from "./memory-schema.js";

const log = createSubsystemLogger("memory/migrations");

const SCHEMA_VERSION_KEY = "schema_version";

export type Migration = {
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_skill_executions_crystal ON skill_executions(skill_crystal_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_skill_executions_time ON skill_executions(started_at)`,
      );

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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_trust_edges_truster ON peer_trust_edges(truster_pubkey)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_trust_edges_trustee ON peer_trust_edges(trustee_pubkey)`,
      );

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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_lineage ON chunks(stable_skill_id, skill_version, lineage_hash)`,
      );
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

      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_valid_time ON chunks(valid_time_start, valid_time_end)`,
      );
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_emotional_anchors_created ON emotional_anchors(created_at)`,
      );
    },
  },
  {
    version: 9,
    description:
      "PLAN-9 Memory Supremacy: Knowledge Graph (GAP-1/2), Reconsolidation (GAP-5), " +
      "Spacing Effect (GAP-7), Prospective Memory (GAP-9), Zeigarnik open loops (GAP-8), " +
      "Synaptic Tagging (GAP-10)",
    up: (db: DatabaseSync) => {
      // ── GAP-1: Knowledge Graph — entities table ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          properties TEXT DEFAULT '{}',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          mention_count INTEGER DEFAULT 1,
          importance REAL DEFAULT 0.5,
          UNIQUE(name, entity_type)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)`);

      // ── GAP-1/2: Knowledge Graph — relationships table with temporal validity ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS relationships (
          id TEXT PRIMARY KEY,
          source_entity_id TEXT NOT NULL REFERENCES entities(id),
          target_entity_id TEXT NOT NULL REFERENCES entities(id),
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
      db.exec(`CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_rel_temporal ON relationships(valid_from, valid_until)`,
      );

      // ── GAP-5: Memory Reconsolidation — labile state tracking ──
      ensureColumn(db, "chunks", "labile_until", "INTEGER");
      ensureColumn(db, "chunks", "reconsolidation_count", "INTEGER DEFAULT 0");

      // ── GAP-7: Spacing Effect — access interval tracking ──
      ensureColumn(db, "chunks", "access_timestamps", "TEXT DEFAULT '[]'");
      ensureColumn(db, "chunks", "spacing_score", "REAL DEFAULT 0");

      // ── GAP-8: Zeigarnik Effect — open loop detection ──
      ensureColumn(db, "chunks", "open_loop", "INTEGER DEFAULT 0");
      ensureColumn(db, "chunks", "open_loop_context", "TEXT");

      // ── GAP-10: Synaptic Tagging & Capture ──
      ensureColumn(db, "chunks", "captured_by", "TEXT");

      // ── GAP-9: Prospective Memory — event-triggered future recall ──
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
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_prospective_active ON prospective_memories(triggered_at)`,
      );

      // ── GAP-11: Active Inference — epistemic directives ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS epistemic_directives (
          id TEXT PRIMARY KEY,
          directive_type TEXT NOT NULL,
          question TEXT NOT NULL,
          context TEXT DEFAULT '',
          priority REAL DEFAULT 0.5,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          resolution TEXT,
          source_entity_ids TEXT DEFAULT '[]',
          attempts INTEGER DEFAULT 0
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_epistemic_active ON epistemic_directives(resolved_at)`,
      );
    },
  },
  {
    version: 10,
    description: "PLAN-13 Phase B: per-skill capability grants table, keyed on content hash",
    up: (db: DatabaseSync) => {
      // Persists operator decisions on capability requests from ingested
      // skills. Keyed on content_hash (not skill name) so a swap-out of a
      // malicious update under the same name does not inherit grants.
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_capability_grants (
          content_hash TEXT NOT NULL,
          capability TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
          scope_json TEXT DEFAULT '{}',
          granted_at INTEGER NOT NULL,
          granted_by TEXT,
          PRIMARY KEY (content_hash, capability)
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_skill_grants_hash ON skill_capability_grants(content_hash)`,
      );
    },
  },
  {
    version: 11,
    description:
      "Network census history: persist gossipsub-received bootnode snapshots " +
      "so dashboards can render network growth over time across restarts.",
    up: (db: DatabaseSync) => {
      // One row per (publishing-bootnode, generated_at). PRIMARY KEY de-dups
      // identical snapshots; an UPSERT path in the writer makes re-receipts
      // a no-op. by_tier/by_address_type are stored as JSON to preserve the
      // full breakdown without paying for an extra table.
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_census_history (
          source_peer_id TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL,
          lifetime_unique_peers INTEGER NOT NULL,
          active_last_24h INTEGER NOT NULL,
          active_last_7d INTEGER NOT NULL,
          by_tier_json TEXT NOT NULL DEFAULT '{}',
          by_address_type_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (source_peer_id, generated_at)
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_network_census_snapshot_at ON network_census_history(snapshot_at)`,
      );
    },
  },
  {
    version: 12,
    description:
      "PLAN-15 procedural-memory curator: per-SKILL.md lifecycle table " +
      "(origin, state, usage/error counts, last_used_at, pinned). Backfilled " +
      "from skill_executions joined on chunks.skill_category.",
    up: (db: DatabaseSync) => {
      // One row per SKILL.md (keyed on the canonical skill_name slug). A
      // single SKILL.md may map to N memory chunks (versions, mutations);
      // lifecycle is tracked at the SKILL.md level because that is what the
      // curator's heuristic + LLM-judge passes operate on.
      db.exec(`
        CREATE TABLE IF NOT EXISTS skill_lifecycle (
          skill_name         TEXT PRIMARY KEY,
          origin             TEXT NOT NULL DEFAULT 'unknown',
          state              TEXT NOT NULL DEFAULT 'active',
          created_at         INTEGER NOT NULL,
          last_used_at       INTEGER,
          usage_count        INTEGER NOT NULL DEFAULT 0,
          success_count      INTEGER NOT NULL DEFAULT 0,
          error_count        INTEGER NOT NULL DEFAULT 0,
          consolidated_into  TEXT,
          pinned             INTEGER NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_state ON skill_lifecycle(state)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_origin ON skill_lifecycle(origin)`);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_skill_lifecycle_last_used ON skill_lifecycle(last_used_at)`,
      );

      // Backfill from skill_executions. A skill_category is treated as the
      // canonical skill_name slug; rows are aggregated to last_used_at /
      // counts. origin defaults to 'unknown' on backfill — fresh writes via
      // the gateway set it correctly.
      db.exec(`
        INSERT OR IGNORE INTO skill_lifecycle (
          skill_name, origin, state, created_at, last_used_at,
          usage_count, success_count, error_count, pinned, updated_at
        )
        SELECT
          c.skill_category                       AS skill_name,
          'unknown'                              AS origin,
          'active'                               AS state,
          MIN(se.started_at)                     AS created_at,
          MAX(se.started_at)                     AS last_used_at,
          COUNT(*)                               AS usage_count,
          SUM(CASE WHEN se.success = 1 THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN se.success = 0 THEN 1 ELSE 0 END) AS error_count,
          0                                      AS pinned,
          CAST(strftime('%s','now') AS INTEGER) * 1000 AS updated_at
        FROM skill_executions se
        JOIN chunks c ON c.id = se.skill_crystal_id
        WHERE c.skill_category IS NOT NULL
          AND c.skill_category != ''
          AND se.completed_at IS NOT NULL
        GROUP BY c.skill_category
      `);
    },
  },
  {
    version: 13,
    description:
      "PLAN-18 SAGE-style graph memory: per-edge gate value + cached topology " +
      "features, training-pair table for the offline gate optimizer, and a " +
      "dream_cycles column for graph-reward telemetry.",
    up: (db: DatabaseSync) => {
      // gate_value defaults to 1.0 so Phase 2 (uniform-gate) is the
      // observable baseline; the optimizer overwrites it once Phase 3
      // training pairs exist. gate_features holds an 8-Float32 BLOB.
      addColumnIfMissing(db, "relationships", "gate_value", "REAL DEFAULT 1.0");
      addColumnIfMissing(db, "relationships", "gate_features", "BLOB");

      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_gate_training_pairs (
          id                     TEXT PRIMARY KEY,
          query                  TEXT NOT NULL,
          ground_truth_chunk_id  TEXT NOT NULL,
          collected_at           INTEGER NOT NULL,
          source                 TEXT NOT NULL DEFAULT 'access_log'
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_graph_gate_training_pairs_collected ` +
          `ON graph_gate_training_pairs(collected_at)`,
      );

      addColumnIfMissing(db, "dream_cycles", "graph_reward_delta", "REAL");
    },
  },
  {
    version: 14,
    description:
      "PLAN-20 executable skill interceptors: append-only intervention_records " +
      "table capturing every pre-action interceptor activation with state " +
      "snapshot, action diff, Ed25519 signature, and a later-patched outcome " +
      "signal.",
    up: (db: DatabaseSync) => {
      // One row per non-NOOP interceptor activation. Outcome signal is
      // backfilled 1-3 turns later by the experience-signal-collector;
      // until then `outcome_tag` is NULL. We never UPDATE other columns
      // after the initial insert (append-only invariant). Signed JSON in
      // `record_json` is the canonical, transportable form for marketplace
      // outcome statistics.
      db.exec(`
        CREATE TABLE IF NOT EXISTS intervention_records (
          id                       TEXT PRIMARY KEY,
          ts                       INTEGER NOT NULL,
          session_key              TEXT NOT NULL,
          skill                    TEXT NOT NULL,
          interceptor_id           TEXT NOT NULL,
          channel                  TEXT NOT NULL DEFAULT 'internal',
          tool_name                TEXT NOT NULL,
          intervention_type        TEXT NOT NULL,
          action_original_json     TEXT NOT NULL,
          action_final_json        TEXT,
          intervention_json        TEXT NOT NULL,
          state_summary_json       TEXT NOT NULL,
          activation_latency_ms    REAL NOT NULL DEFAULT 0,
          intervention_latency_ms  REAL NOT NULL DEFAULT 0,
          outcome_tag              TEXT,
          outcome_evidence         TEXT,
          ed25519_sig              TEXT NOT NULL DEFAULT '',
          pubkey_id                TEXT NOT NULL DEFAULT 'unsigned-local',
          record_json              TEXT NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_intervention_records_skill_ts ` +
          `ON intervention_records(skill, ts)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_intervention_records_interceptor_ts ` +
          `ON intervention_records(interceptor_id, ts)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_intervention_records_session_ts ` +
          `ON intervention_records(session_key, ts)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_intervention_records_outcome ` +
          `ON intervention_records(skill, outcome_tag)`,
      );

      // Per-skill rollup view used by the marketplace + Active Guards UI.
      // Drops and recreates idempotently — sqlite has no CREATE OR REPLACE
      // VIEW so we drop first.
      db.exec(`DROP VIEW IF EXISTS skill_interceptor_stats`);
      db.exec(`
        CREATE VIEW skill_interceptor_stats AS
        SELECT
          skill,
          interceptor_id,
          COUNT(*)                                                                  AS fire_count,
          SUM(CASE WHEN outcome_tag = 'downstream-success' THEN 1 ELSE 0 END)       AS success_count,
          SUM(CASE WHEN outcome_tag = 'downstream-failure' THEN 1 ELSE 0 END)       AS failure_count,
          SUM(CASE WHEN outcome_tag = 'user-confirmed-block' THEN 1 ELSE 0 END)     AS user_confirmed_count,
          SUM(CASE WHEN outcome_tag = 'user-overrode-block' THEN 1 ELSE 0 END)      AS user_override_count,
          AVG(activation_latency_ms + intervention_latency_ms)                       AS avg_latency_ms,
          MIN(ts)                                                                    AS first_seen_ts,
          MAX(ts)                                                                    AS last_seen_ts
        FROM intervention_records
        GROUP BY skill, interceptor_id
      `);
    },
  },
  {
    version: 15,
    description:
      "PLAN-20 follow-up: persistent interceptor_strikes table so the " +
      "3-strikes auto-disable counter survives gateway restarts.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS interceptor_strikes (
          interceptor_id      TEXT PRIMARY KEY,
          strikes             INTEGER NOT NULL DEFAULT 0,
          disabled            INTEGER NOT NULL DEFAULT 0,
          last_failure_ts     INTEGER,
          last_failure_reason TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_interceptor_strikes_disabled ` +
          `ON interceptor_strikes(disabled)`,
      );
    },
  },
  {
    version: 16,
    description:
      "PLAN-23 SABM: relationship belief history (non-destructive audit of " +
      "every reinforce / flag / supersede) + a last_reinforced_at column on " +
      "relationships. Relationship temporal columns stay valid_from/valid_until " +
      "(NOT the chunks valid_time_* vocabulary).",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS relationship_belief_history (
          id                 TEXT PRIMARY KEY,
          relationship_id    TEXT NOT NULL,
          action             TEXT NOT NULL,
          prev_weight        REAL,
          new_weight         REAL,
          evidence_chunk_ids TEXT DEFAULT '[]',
          valid_from         INTEGER,
          valid_until        INTEGER,
          created_at         INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_rel_belief_history_rel ` +
          `ON relationship_belief_history(relationship_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_rel_belief_history_action ` +
          `ON relationship_belief_history(action)`,
      );
      // Transaction-time / reinforcement bookkeeping on relationships.
      // Idempotent: addColumnIfMissing no-ops on an already-upgraded DB.
      addColumnIfMissing(db, "relationships", "last_reinforced_at", "INTEGER");
    },
  },
  {
    version: 17,
    description:
      "PLAN-24 HORMA Phase 0: provenance pointers. evidence_refs is a JSON array " +
      "of {kind:'session',path,line} | {kind:'journal',runId,seq} anchoring an " +
      "extracted fact / dream insight back to its raw source so memory_expand can " +
      "recover verbatim ground truth and reconsolidation can check faithfulness.",
    up: (db: DatabaseSync) => {
      // Null-tolerant: legacy chunks have no provenance and stay NULL.
      addColumnIfMissing(db, "chunks", "evidence_refs", "TEXT");
    },
  },
  {
    version: 18,
    description:
      "PLAN-24 HORMA Phase 3: construction_rules — the evolving memory-architect " +
      "rule library. Natural-language rules promoted from contrastive construction " +
      "failures and injected into the extraction prompt. Birth-hormone columns " +
      "support Phase 4 state-conditional activation.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS construction_rules (
          id             TEXT PRIMARY KEY,
          rule_text      TEXT NOT NULL,
          category       TEXT,
          status         TEXT NOT NULL DEFAULT 'active',
          source         TEXT NOT NULL DEFAULT 'textgrad',
          version        INTEGER NOT NULL DEFAULT 1,
          ci95_low       REAL,
          birth_dopamine REAL,
          birth_cortisol REAL,
          birth_oxytocin REAL,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_construction_rules_status ` +
          `ON construction_rules(status)`,
      );
    },
  },
  {
    version: 19,
    description:
      "PLAN-24 HORMA Phase 5: parent_entity_id on entities so members can point " +
      "at the summary entity that abstracts their community (coarse-to-fine graph " +
      "navigation). entity_type 'summary' and relation_type 'summarizes' are TEXT " +
      "values — no schema change needed for those.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "entities", "parent_entity_id", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities(parent_entity_id)`);
    },
  },
  {
    version: 20,
    description:
      "PLAN-26 Aubaine group-buy coordination layer: offer/intent directory, " +
      "demand-matched syndicates, members, and non-custodial threshold settlements. " +
      "Local index over signed offers/intents gossiped on aubaine/{offers,intents}/v1; " +
      "settlement is many-buyers-to-one-supplier via EIP-3009, never custodied here.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS group_buy_offers (
          id              TEXT PRIMARY KEY,
          sku_canonical   TEXT NOT NULL,
          sku_description TEXT NOT NULL,
          unit_price_usdc REAL NOT NULL,
          moq             INTEGER NOT NULL,
          lead_time_days  INTEGER NOT NULL,
          supplier_peer_id  TEXT,
          supplier_pubkey   TEXT NOT NULL,
          supplier_a2a_url  TEXT NOT NULL,
          supplier_wallet   TEXT,
          deposit_bps     INTEGER NOT NULL DEFAULT 4000,
          expires_at      INTEGER NOT NULL,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gbo_sku ON group_buy_offers(sku_canonical, expires_at)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS group_buy_intents (
          id                 TEXT PRIMARY KEY,
          sku_canonical      TEXT NOT NULL,
          sku_description    TEXT NOT NULL,
          max_price_usdc     REAL NOT NULL,
          qty                INTEGER NOT NULL,
          lead_time_max_days INTEGER NOT NULL,
          buyer_peer_id      TEXT,
          buyer_pubkey       TEXT NOT NULL,
          is_local           INTEGER NOT NULL DEFAULT 0,
          mandate_json       TEXT DEFAULT '{}',
          expires_at         INTEGER NOT NULL,
          created_at         INTEGER NOT NULL,
          updated_at         INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gbi_sku ON group_buy_intents(sku_canonical, expires_at)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS group_buy_syndicates (
          id               TEXT PRIMARY KEY,
          offer_id         TEXT NOT NULL,
          sku_canonical    TEXT NOT NULL,
          unit_price_usdc  REAL NOT NULL,
          moq              INTEGER NOT NULL,
          committed_qty    INTEGER NOT NULL DEFAULT 0,
          status           TEXT NOT NULL DEFAULT 'forming',
          supplier_pubkey  TEXT NOT NULL,
          supplier_a2a_url TEXT NOT NULL,
          coordinator_peer_id TEXT,
          strike_deadline  INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gbsy_sku ON group_buy_syndicates(sku_canonical, status)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS group_buy_members (
          id            TEXT PRIMARY KEY,
          syndicate_id  TEXT NOT NULL,
          intent_id     TEXT NOT NULL,
          buyer_pubkey  TEXT NOT NULL,
          buyer_peer_id TEXT,
          qty           INTEGER NOT NULL,
          amount_usdc   REAL NOT NULL,
          commit_status TEXT NOT NULL DEFAULT 'invited',
          auth_token    TEXT,
          updated_at    INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gbm_syndicate ` +
          `ON group_buy_members(syndicate_id, commit_status)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS group_buy_settlements (
          id               TEXT PRIMARY KEY,
          syndicate_id     TEXT NOT NULL,
          member_id        TEXT NOT NULL,
          buyer_pubkey     TEXT NOT NULL,
          supplier_address TEXT NOT NULL,
          amount_usdc      REAL NOT NULL,
          leg              TEXT NOT NULL DEFAULT 'deposit',
          auth_token       TEXT,
          tx_hash          TEXT,
          status           TEXT NOT NULL DEFAULT 'pending',
          error            TEXT,
          created_at       INTEGER NOT NULL,
          settled_at       INTEGER
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_gbs_syndicate ` +
          `ON group_buy_settlements(syndicate_id, status)`,
      );
    },
  },
  {
    version: 21,
    description: "PLAN-28 Part B: retrieval_trace observability table",
    up: (db: DatabaseSync) => {
      // Sampled per-retrieval layer-contribution trace. One row per sampled
      // search/recall; `extra` carries the full typed counts as JSON so the
      // schema stays stable as layers are added. Lets the LongMemEval harness
      // (and ad-hoc analysis) answer "is each retrieval layer pulling its
      // weight" without a live DB probe. Written best-effort behind a sampling
      // rate; never on the hot path's critical section.
      db.exec(`
        CREATE TABLE IF NOT EXISTS retrieval_trace (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          kind         TEXT NOT NULL,
          query_len    INTEGER NOT NULL DEFAULT 0,
          vector_hits  INTEGER NOT NULL DEFAULT 0,
          keyword_hits INTEGER NOT NULL DEFAULT 0,
          graph_hits   INTEGER NOT NULL DEFAULT 0,
          fused        INTEGER NOT NULL DEFAULT 0,
          extra        TEXT,
          created_at   INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_retrieval_trace_kind_created ` +
          `ON retrieval_trace(kind, created_at)`,
      );
    },
  },
];

/**
 * Idempotently add a column. PRAGMA table_info returns the live columns
 * so we can no-op when a migration runs more than once (or against a DB
 * that already has the column from a previous schema).
 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = rows.some((r) => r.name === column);
  if (exists) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Read the current schema version from the meta table.
 */
function getSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SCHEMA_VERSION_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      return 0;
    }
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
export function runMigrations(
  db: DatabaseSync,
  migrations: Migration[] = MIGRATIONS,
): { from: number; to: number; ran: number } {
  const current = getSchemaVersion(db);
  const pending = migrations.filter((m) => m.version > current);

  if (pending.length === 0) {
    return { from: current, to: current, ran: 0 };
  }

  pending.sort((a, b) => a.version - b.version);

  let applied = current;
  for (const migration of pending) {
    try {
      log.debug(`running migration v${migration.version}: ${migration.description}`);
      // Run each migration and its version bump atomically. SQLite supports
      // transactional DDL, so on any failure the rollback leaves the schema
      // exactly as it was — no half-applied migration that a later run would
      // either skip (silent corruption) or choke on. None of the migrations use
      // statements that can't run in a transaction (VACUUM/journal_mode/ATTACH).
      db.exec("BEGIN");
      try {
        migration.up(db);
        setSchemaVersion(db, migration.version);
        db.exec("COMMIT");
      } catch (inner) {
        db.exec("ROLLBACK");
        throw inner;
      }
      applied = migration.version;
    } catch (err) {
      // A failed migration is serious — surface it loudly and stop so later
      // migrations don't run against an unexpected schema.
      log.error(`migration v${migration.version} failed and was rolled back: ${String(err)}`);
      break;
    }
  }

  const result = { from: current, to: applied, ran: applied - current };
  if (result.ran > 0) {
    log.debug(`migrations complete`, result);
  }
  return result;
}
