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
  {
    version: 22,
    description:
      "PLAN-29 Forage bounty economy: bounty directory (posts/claims/settlements) " +
      "and heartbeat streams. Local index over funded BountyEnvelope v2 objects " +
      "gossiped on bitterbot/bounties/v1; payouts ride the existing " +
      "revenue_payment_queue, settlement is poster-wallet -> hunter-wallet " +
      "(never custodied here).",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_posts (
          bounty_id         TEXT PRIMARY KEY,
          poster_pubkey     TEXT NOT NULL,
          poster_peer_id    TEXT,
          poster_wallet     TEXT NOT NULL,
          kind              TEXT NOT NULL DEFAULT 'oneshot',
          category          TEXT NOT NULL,
          spec_public       TEXT NOT NULL,
          oracle_commitment TEXT NOT NULL,
          oracle_type       TEXT NOT NULL DEFAULT 'mechanical',
          reward_usdc       REAL NOT NULL,
          funding_proof     TEXT,
          claim_stake_usdc  REAL NOT NULL DEFAULT 0,
          max_claims        INTEGER NOT NULL DEFAULT 1,
          is_local          INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'open',
          deadline          INTEGER,
          expires_at        INTEGER NOT NULL,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_posts_scan ` +
          `ON bounty_posts(category, status, deadline)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_posts_expiry ON bounty_posts(status, expires_at)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_claims (
          id             TEXT PRIMARY KEY,
          bounty_id      TEXT NOT NULL,
          hunter_pubkey  TEXT NOT NULL,
          hunter_peer_id TEXT,
          hunter_wallet  TEXT NOT NULL,
          stake_usdc     REAL NOT NULL DEFAULT 0,
          stake_tx_hash  TEXT,
          commit_hash    TEXT,
          status         TEXT NOT NULL DEFAULT 'claimed',
          deliverable_ref TEXT,
          claimed_at     INTEGER NOT NULL,
          delivered_at   INTEGER,
          updated_at     INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_claims_bounty ` +
          `ON bounty_claims(bounty_id, status)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_claims_hunter ` +
          `ON bounty_claims(hunter_pubkey, status)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_settlements (
          id              TEXT PRIMARY KEY,
          bounty_id       TEXT NOT NULL,
          claim_id        TEXT NOT NULL,
          poster_pubkey   TEXT NOT NULL,
          hunter_pubkey   TEXT NOT NULL,
          hunter_wallet   TEXT NOT NULL,
          amount_usdc     REAL NOT NULL,
          oracle_verdict  TEXT NOT NULL,
          oracle_evidence TEXT,
          judge_capped    INTEGER NOT NULL DEFAULT 0,
          payment_queue_id INTEGER,
          tx_hash         TEXT,
          status          TEXT NOT NULL DEFAULT 'pending',
          error           TEXT,
          created_at      INTEGER NOT NULL,
          settled_at      INTEGER
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_settlements_bounty ` +
          `ON bounty_settlements(bounty_id, status)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_bounty_settlements_claim ` +
          `ON bounty_settlements(claim_id)`,
      );

      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_streams (
          id                TEXT PRIMARY KEY,
          bounty_id         TEXT NOT NULL,
          poster_pubkey     TEXT NOT NULL,
          hunter_pubkey     TEXT NOT NULL,
          cadence_seconds   INTEGER NOT NULL,
          per_check_usdc    REAL NOT NULL,
          alert_bonus_usdc  REAL NOT NULL DEFAULT 0,
          observation_head  TEXT,
          checks_total      INTEGER NOT NULL DEFAULT 0,
          checks_paid       INTEGER NOT NULL DEFAULT 0,
          audits_total      INTEGER NOT NULL DEFAULT 0,
          audits_failed     INTEGER NOT NULL DEFAULT 0,
          status            TEXT NOT NULL DEFAULT 'active',
          last_check_at     INTEGER,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_streams_active ` +
          `ON bounty_streams(status, last_check_at)`,
      );
    },
  },
  {
    version: 23,
    description:
      "PLAN-29 Phase 1.3: poster-side sealed oracle spec. The commitment " +
      "hash travels in the envelope; the spec itself (with salt) stays " +
      "local to the posting node until verification time.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "bounty_posts", "oracle_spec_private", "TEXT");
    },
  },
  {
    version: 24,
    description:
      "PLAN-29 Phase 5 (Night Shift): hunter-side claim mirror. Claims live " +
      "poster-side; forage_hunts is this node's own record of work it has " +
      "taken on across the mesh — what it claimed, delivered, and earned.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS forage_hunts (
          claim_id       TEXT PRIMARY KEY,
          bounty_id      TEXT NOT NULL,
          poster_pubkey  TEXT NOT NULL,
          poster_a2a_url TEXT NOT NULL,
          category       TEXT NOT NULL,
          kind           TEXT NOT NULL,
          reward_usdc    REAL NOT NULL,
          per_check_usdc REAL,
          monitor_url    TEXT,
          cadence_seconds INTEGER,
          status         TEXT NOT NULL DEFAULT 'claimed',
          checks_sent    INTEGER NOT NULL DEFAULT 0,
          earned_usdc    REAL NOT NULL DEFAULT 0,
          last_action_at INTEGER,
          claimed_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_forage_hunts_active ON forage_hunts(status, last_action_at)`,
      );
    },
  },
  {
    version: 25,
    description:
      "PLAN-29 Phase 4 (legal-gated): bounty pool funder authorizations. " +
      "Each row is one funder's signed EIP-3009 auth toward a pool bounty; " +
      "capture is confirm-then-capture (quorum + oracle pass) and " +
      "structurally non-custodial (funds move funder -> hunter, never here).",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_pool_auths (
          id            TEXT PRIMARY KEY,
          bounty_id     TEXT NOT NULL,
          funder_pubkey TEXT NOT NULL,
          funder_wallet TEXT NOT NULL,
          amount_usdc   REAL NOT NULL,
          auth_json     TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pledged',
          tx_hash       TEXT,
          error         TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_pool_auths ON bounty_pool_auths(bounty_id, status)`,
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_bounty_pool_auths_funder ` +
          `ON bounty_pool_auths(bounty_id, funder_wallet)`,
      );
    },
  },
  {
    version: 26,
    description:
      "PLAN-30 G0.1: per-check observation log + per-hunter audit state. " +
      "forage/checkin previously folded every check into one rolling head, " +
      "leaving nothing to audit against; bounty_stream_checks preserves each " +
      "check's digest so an auditor can re-observe and compare, and " +
      "forage_hunter_audit carries the BOINC-style consecutive-valid counter " +
      "that drives the adaptive audit rate and gates payment release.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS bounty_stream_checks (
          stream_id      TEXT NOT NULL,
          seq            INTEGER NOT NULL,
          content_digest TEXT NOT NULL,
          digest_scheme  TEXT NOT NULL DEFAULT 'raw-v1',
          sealed_digest  TEXT,
          simhash        TEXT,
          alert          INTEGER NOT NULL DEFAULT 0,
          observed_at    INTEGER NOT NULL,
          prev_head      TEXT,
          head           TEXT NOT NULL,
          audit_status   TEXT NOT NULL DEFAULT 'unaudited',
          audited_at     INTEGER,
          auditor_note   TEXT,
          PRIMARY KEY (stream_id, seq)
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_bounty_stream_checks_audit ` +
          `ON bounty_stream_checks(audit_status, observed_at)`,
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS forage_hunter_audit (
          hunter_pubkey        TEXT PRIMARY KEY,
          cv                   INTEGER NOT NULL DEFAULT 0,
          audits_total         INTEGER NOT NULL DEFAULT 0,
          audits_passed        INTEGER NOT NULL DEFAULT 0,
          audits_failed        INTEGER NOT NULL DEFAULT 0,
          audits_unverifiable  INTEGER NOT NULL DEFAULT 0,
          frauds               INTEGER NOT NULL DEFAULT 0,
          last_audit_at        INTEGER,
          updated_at           INTEGER NOT NULL
        )
      `);
      // G0.3 lands the poster-issued per-claim nonce on this column; added
      // here so the claim handler can start issuing nonces without a second
      // migration.
      addColumnIfMissing(db, "bounty_claims", "claim_nonce", "TEXT");
      // Hunter-side change detection (alert path): remember the previous
      // digest so Night Shift can set observation.alert on content change.
      addColumnIfMissing(db, "forage_hunts", "last_content_digest", "TEXT");
    },
  },
  {
    version: 27,
    description:
      "PLAN-30 G0.3: hunter-side storage of the poster-issued claim nonce. " +
      "The nonce authenticates check-ins (only its holder can check in on " +
      "the stream) via sealedDigest = sha256(nonce || contentHash).",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "forage_hunts", "claim_nonce", "TEXT");
    },
  },
  {
    version: 28,
    description:
      "PLAN-30 G0.5: precise stream budget accounting (spent_usdc, needed " +
      "once alert bonuses ride the same budget as per-check pay and once " +
      "multiple claims share one bounty budget) + hunter-side settlement " +
      "reconciliation columns for the verified-earnings morning report.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "bounty_streams", "spent_usdc", "REAL NOT NULL DEFAULT 0");
      // Backfill: everything paid so far was per-check pay only.
      db.exec(`UPDATE bounty_streams SET spent_usdc = checks_paid * per_check_usdc`);
      addColumnIfMissing(db, "forage_hunts", "settlement_status", "TEXT");
      addColumnIfMissing(db, "forage_hunts", "settlement_tx", "TEXT");
    },
  },
  {
    version: 29,
    description:
      "PLAN-31 C1: circles (collective-agency substrate). A circle is a " +
      "closed, mutually-paired member set with a shared encrypted channel. " +
      "Deliberately domain-agnostic: `kind` distinguishes expense/care/team/... " +
      "so the same tables carry every coordination domain (sections 11-12). " +
      "Members pin a payout wallet at pair time (settlements refuse any other " +
      "payTo) and hold an extensible scope set (default-deny). `key_epoch` " +
      "bumps on every membership change so the channel key rotates.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circles (
          circle_id     TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'expense',
          creator_pubkey TEXT NOT NULL,
          key_epoch     INTEGER NOT NULL DEFAULT 0,
          status        TEXT NOT NULL DEFAULT 'active',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_members (
          circle_id     TEXT NOT NULL,
          member_pubkey TEXT NOT NULL,
          display_name  TEXT,
          pinned_wallet TEXT,
          a2a_url       TEXT,
          role          TEXT NOT NULL DEFAULT 'member',
          scopes_json   TEXT NOT NULL DEFAULT '[]',
          status        TEXT NOT NULL DEFAULT 'active',
          joined_at     INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          PRIMARY KEY (circle_id, member_pubkey)
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_members_member ` +
          `ON circle_members(member_pubkey, status)`,
      );
    },
  },
  {
    version: 30,
    description:
      "PLAN-31 C1/C2: circle connection + social tables. Invites store only " +
      "sha256(secret) — the secret lives in the invite code, never at rest. " +
      "circle_events is the typed, domain-agnostic shared-state ledger (the " +
      "tab is event_type 'expense.*'; a care shift or co-op order is another " +
      "namespace, section 11): per-author signed hash chains, append-only, " +
      "with heads_json for fork detection. NO settlement columns — money " +
      "movement is Phase 2, dark. circle_messages buffers hostile-principal " +
      "agent conversation for digest-batching (humans see summaries). " +
      "circle_disclosure_grants is the default-deny per-category consent " +
      "model (presence + free/busy are the only built-in allowances, in " +
      "code). circle_peer_presence is last-seen liveness for the People UI.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_invites (
          invite_id        TEXT PRIMARY KEY,
          circle_id        TEXT NOT NULL,
          inviter_pubkey   TEXT NOT NULL,
          token_hash       TEXT NOT NULL,
          scopes_json      TEXT NOT NULL DEFAULT '[]',
          max_uses         INTEGER NOT NULL DEFAULT 1,
          uses             INTEGER NOT NULL DEFAULT 0,
          expires_at       INTEGER NOT NULL,
          status           TEXT NOT NULL DEFAULT 'open',
          created_at       INTEGER NOT NULL,
          last_redeemed_at INTEGER,
          last_redeemed_by TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_invites_circle ` +
          `ON circle_invites(circle_id, status)`,
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_events (
          event_id      TEXT PRIMARY KEY,
          circle_id     TEXT NOT NULL,
          author_pubkey TEXT NOT NULL,
          seq           INTEGER NOT NULL,
          prev_hash     TEXT,
          event_type    TEXT NOT NULL,
          body_json     TEXT NOT NULL,
          heads_json    TEXT NOT NULL DEFAULT '{}',
          envelope_json TEXT NOT NULL,
          event_hash    TEXT NOT NULL,
          claimed_at    INTEGER NOT NULL,
          received_at   INTEGER NOT NULL,
          UNIQUE (circle_id, author_pubkey, seq)
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_events_circle ` +
          `ON circle_events(circle_id, received_at)`,
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_messages (
          message_id    TEXT PRIMARY KEY,
          circle_id     TEXT NOT NULL,
          author_pubkey TEXT NOT NULL,
          direction     TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'message',
          thread_id     TEXT,
          content       TEXT NOT NULL,
          scan_severity TEXT,
          envelope_id   TEXT,
          created_at    INTEGER NOT NULL,
          digested_at   INTEGER
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_messages_circle ` +
          `ON circle_messages(circle_id, created_at)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_messages_undigested ` +
          `ON circle_messages(circle_id, digested_at)`,
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_disclosure_grants (
          category   TEXT NOT NULL,
          circle_id  TEXT NOT NULL DEFAULT '*',
          allowed    INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (category, circle_id)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_peer_presence (
          peer_pubkey  TEXT PRIMARY KEY,
          a2a_url      TEXT,
          last_seen_at INTEGER NOT NULL,
          last_status  TEXT
        )
      `);
    },
  },
  {
    version: 31,
    description:
      "PLAN-31 C1 transport: the store-and-forward mailbox (§3.2) + sealed-" +
      "box endpoints. Members publish an X25519 box pubkey + mailbox URL in " +
      "signed join/presence envelopes; mailbox blobs are sealed per-recipient " +
      "(ephemeral ECDH + HKDF + AES-256-GCM) so a mailbox host stores what it " +
      "cannot read ('no server that can read your messages'). mailbox_blobs " +
      "is the HOST side (nodes with circles.mailbox.serve=true): sender-" +
      "signature required, per-sender rate limits, per-recipient quotas, " +
      "~30d TTL.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circle_members", "box_pubkey", "TEXT");
      addColumnIfMissing(db, "circle_members", "mailbox_url", "TEXT");
      addColumnIfMissing(db, "circle_peer_presence", "box_pubkey", "TEXT");
      addColumnIfMissing(db, "circle_peer_presence", "mailbox_url", "TEXT");
      db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_blobs (
          blob_id          TEXT PRIMARY KEY,
          recipient_pubkey TEXT NOT NULL,
          sender_pubkey    TEXT NOT NULL,
          blob_json        TEXT NOT NULL,
          created_at       INTEGER NOT NULL,
          expires_at       INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_mailbox_blobs_recipient ` +
          `ON mailbox_blobs(recipient_pubkey, created_at)`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mailbox_blobs_expiry ON mailbox_blobs(expires_at)`);
    },
  },
  {
    version: 32,
    description:
      "PLAN-31 C3: the weekly briefing (§1 verb 6) — one synchronized digest " +
      "of the connections' shared life, compiled LOCALLY per node from " +
      "consented data (presence, reciprocity, tab fold, pending asks). " +
      "Replaces the feed; never fanned out (each node compiles its own view).",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_briefings (
          briefing_id TEXT PRIMARY KEY,
          compiled_at INTEGER NOT NULL,
          window_ms   INTEGER NOT NULL,
          content     TEXT NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_briefings_time ON circle_briefings(compiled_at)`,
      );
    },
  },
  {
    version: 33,
    description:
      "PLAN-33 Phase 1: canonical_facts — the semantic ledger. A small, " +
      "hard-capped tier of exact key-value facts (repo names, endpoints, " +
      "identities, standing choices) injected unconditionally into every " +
      "system prompt, addressed by key instead of embedding similarity. " +
      "Bitemporal: contradictions close the old row's validity window " +
      "(valid_until + superseded_by) instead of deleting, so point-in-time " +
      "queries and provenance survive. The partial unique index enforces " +
      "one current belief per key.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS canonical_facts (
          id                 TEXT PRIMARY KEY,
          key                TEXT NOT NULL,
          value              TEXT NOT NULL,
          statement          TEXT NOT NULL,
          category           TEXT NOT NULL,
          confidence         REAL NOT NULL,
          mention_count      INTEGER NOT NULL DEFAULT 1,
          first_seen_at      INTEGER NOT NULL,
          last_confirmed_at  INTEGER NOT NULL,
          valid_from         INTEGER NOT NULL,
          valid_until        INTEGER,
          superseded_by      TEXT,
          source             TEXT NOT NULL,
          evidence_chunk_ids TEXT NOT NULL DEFAULT '[]',
          status             TEXT NOT NULL DEFAULT 'active'
        )
      `);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_current ` +
          `ON canonical_facts(key) WHERE valid_until IS NULL`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_canonical_status ON canonical_facts(status, category)`,
      );
    },
  },
  {
    version: 34,
    description:
      "PLAN-34 Phase 0: closed-loop cognition schema slots + containment " +
      "sweeps. (1) chunks.session_trust — session trust persisted at write " +
      "time so first-party determinability never depends on re-resolving " +
      "prunable sessions.json history (Phase 4 promotion gate reads it). " +
      "(2) canonical_conflicts — pin() records tier-rejections and rapid " +
      "same-key supersedes here; the Phase 1 extraction path sweeps them " +
      "into contradiction directives ('Which is current for <key>?'). " +
      "(3) epistemic_directives.status — 'open' | 'answered' | 'expired'; " +
      "Phase 1's two-tier resolution and the softened expireOld flip this " +
      "instead of DELETEing. (4) One-time reset of attempts on unresolved " +
      "directives: the old read path incremented per run attempt and per " +
      "compaction (the live attempts=491 artifact), so historical counts " +
      "are meaningless under increment-only-on-injection. The reset lands " +
      "in the SAME commit as the read-side fix (Phase 0 adversarial pass " +
      "caught the original sequencing, where the reset would have been " +
      "consumed by the old incrementer before the semantics existed). " +
      "(5) canonical_facts.corroboration_count — tier-0 (promotion/web) " +
      "same-value confirmations count here, never into confidence/recency. " +
      "(6) research_findings — the persisted queue behind deterministic " +
      "research surfacing (Phase 2b).",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "chunks", "session_trust", "TEXT");

      db.exec(`
        CREATE TABLE IF NOT EXISTS canonical_conflicts (
          id              TEXT PRIMARY KEY,
          key             TEXT NOT NULL,
          kind            TEXT NOT NULL,
          current_value   TEXT NOT NULL,
          proposed_value  TEXT NOT NULL,
          current_source  TEXT NOT NULL,
          proposed_source TEXT NOT NULL,
          created_at      INTEGER NOT NULL,
          consumed_at     INTEGER,
          directive_id    TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_canonical_conflicts_open ` +
          `ON canonical_conflicts(consumed_at, created_at)`,
      );

      addColumnIfMissing(db, "epistemic_directives", "status", "TEXT NOT NULL DEFAULT 'open'");

      db.exec(`UPDATE epistemic_directives SET attempts = 0 WHERE resolved_at IS NULL`);

      // PLAN-34 Phase 2b: (5) tier-0 corroboration counter — web/promotion
      // agreement is tracked separately and can never move confidence — and
      // (6) research_findings, the small persisted queue behind the
      // deterministic "while you were away, I looked into X" surfacing.
      addColumnIfMissing(
        db,
        "canonical_facts",
        "corroboration_count",
        "INTEGER NOT NULL DEFAULT 0",
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_findings (
          id          TEXT PRIMARY KEY,
          target_id   TEXT,
          finding     TEXT NOT NULL,
          source_url  TEXT,
          relevance   REAL,
          created_at  INTEGER NOT NULL,
          surfaced_at INTEGER
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_research_findings_unsurfaced ` +
          `ON research_findings(surfaced_at, created_at)`,
      );

      // PLAN-34 Phase 2c: (7) research_egress_log — one audit row per
      // network seam (search-query, fetch-host, transport-post) with
      // destination and payload hash/length. The dashboard renders it; the
      // log must never understate the real network footprint.
      db.exec(`
        CREATE TABLE IF NOT EXISTS research_egress_log (
          id           TEXT PRIMARY KEY,
          seam         TEXT NOT NULL,
          destination  TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_len  INTEGER NOT NULL,
          created_at   INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_research_egress_time ON research_egress_log(created_at)`,
      );
    },
  },
  {
    version: 35,
    description:
      "Event-loop stall audit: index the heavy read paths that were " +
      "full-scanning/full-sorting large tables on the gateway loop. " +
      "(1) chunks(curiosity_reward) + chunks(updated_at), both PARTIAL on " +
      "curiosity_reward IS NOT NULL (a small subset, so negligible write " +
      "overhead) — dream.curiosityReward's AVG/MIN/MAX aggregate and its " +
      "ORDER BY updated_at DESC LIMIT 50 both scanned/sorted the whole chunks " +
      "table. (2) intervention_records(ts) — guards.status' ORDER BY ts DESC " +
      "LIMIT 25 had no usable index (existing ones are skill/interceptor " +
      "composites), so it full-sorted the unpruned table for 25 rows.",
    up: (db: DatabaseSync) => {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_curiosity_reward ` +
          `ON chunks(curiosity_reward) WHERE curiosity_reward IS NOT NULL`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_chunks_curiosity_updated ` +
          `ON chunks(updated_at) WHERE curiosity_reward IS NOT NULL`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_intervention_records_ts ON intervention_records(ts)`);
    },
  },
  {
    version: 36,
    description:
      "Census pre-aggregation: network_census_hourly. The skills.networkHistory " +
      "RPC was GROUP-BYing the ~90k-row network_census_history table into hourly " +
      "buckets on every read (~16s synchronous on the gateway loop -> UI " +
      "timeouts). This maintains a per-hour rollup (max across sources per hour, " +
      "the same 'stable lower bound' aggregate the read already used) so the " +
      "dashboard's default (no sourcePeerId) read is a bounded <=720-row lookup " +
      "instead of a full scan. Backfilled once from existing history; the raw " +
      "table stays for the per-source drilldown + its 30-day prune.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_census_hourly (
          hour_bucket           INTEGER PRIMARY KEY,
          generated_at          INTEGER NOT NULL,
          snapshot_at           INTEGER NOT NULL,
          lifetime_unique_peers INTEGER NOT NULL,
          active_last_24h       INTEGER NOT NULL,
          active_last_7d        INTEGER NOT NULL,
          by_tier_json          TEXT,
          by_address_type_json  TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_network_census_hourly_snapshot ` +
          `ON network_census_hourly(snapshot_at)`,
      );
      // One-time backfill from raw history (max across sources per hour bucket).
      db.exec(`
        INSERT INTO network_census_hourly
          (hour_bucket, generated_at, snapshot_at, lifetime_unique_peers,
           active_last_24h, active_last_7d, by_tier_json, by_address_type_json)
        SELECT generated_at / 3600 AS hour_bucket,
               max(generated_at), max(snapshot_at), max(lifetime_unique_peers),
               max(active_last_24h), max(active_last_7d),
               by_tier_json, by_address_type_json
          FROM network_census_history
         GROUP BY generated_at / 3600
        ON CONFLICT(hour_bucket) DO NOTHING
      `);
    },
  },
  {
    version: 37,
    description:
      "PLAN-36 §5.3 (Phase 0): circle_pending_outbound — server-enforced two-" +
      "phase gate for agent circle writes. The `circles` agent tool's confirm " +
      "was prompt-convention only (confirm=true executed on the first call), so " +
      "a prompt-injected agent could send/ask/log_expense with no preview. Now " +
      "the preview mints a single-use, params-bound token persisted here; the " +
      "confirm leg must present a matching, unused, unexpired token or it is " +
      "refused. Bound to the exact action+params so an innocuous preview cannot " +
      "authorize a different send.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_pending_outbound (
          token       TEXT PRIMARY KEY,
          action      TEXT NOT NULL,
          params_hash TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_pending_outbound_expires ` +
          `ON circle_pending_outbound(expires_at)`,
      );
    },
  },
  {
    version: 38,
    description:
      "PLAN-36 Phase 0 (B5): circle_messages.delivery_status. The outbound row " +
      "was inserted BEFORE fan-out with no delivery column, and the UI discarded " +
      "the SendReport — so an all-failed send rendered identically to a delivered " +
      "one. This per-message aggregate ('pending' | 'delivered' | 'partial' | " +
      "'failed'; NULL on inbound and legacy rows) lets the UI show the truth.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circle_messages", "delivery_status", "TEXT");
    },
  },
  {
    version: 39,
    description:
      "PLAN-36 §4 (mailbox-mediated join): circle_pending_join — the INVITEE " +
      "side of an async join. When the inviter has no reachable a2a URL (or is " +
      "offline), the invitee seals its join request into the inviter's mailbox " +
      "and records the pending join here. It is re-posted each drain cycle until " +
      "a signed `welcome` roster arrives (matched by circle_id + inviter_pubkey), " +
      "or the invite expires. Holds only the invitee's OWN single-use secret + " +
      "join envelope, so it can rebuild the request without re-parsing the code.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_pending_join (
          invite_id           TEXT PRIMARY KEY,
          circle_id           TEXT NOT NULL,
          inviter_pubkey      TEXT NOT NULL,
          inviter_mailbox_url TEXT NOT NULL,
          inviter_box_pubkey  TEXT NOT NULL,
          secret              TEXT NOT NULL,
          join_envelope_json  TEXT NOT NULL,
          attempts            INTEGER NOT NULL DEFAULT 1,
          next_attempt_at     INTEGER NOT NULL DEFAULT 0,
          expires_at          INTEGER NOT NULL,
          created_at          INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_circle_pending_join_circle ` +
          `ON circle_pending_join(circle_id, inviter_pubkey)`,
      );
    },
  },
  {
    version: 40,
    description:
      "PLAN-36 Phase A2 (chat shell): circle_read_state — this node's per-circle " +
      "read marker (last_read_at). Unread = inbound circle_messages newer than the " +
      "marker; the rail badges it and opening a circle marks it read. Node-local " +
      "(my view), so one row per circle, no signing. Seeds every EXISTING circle " +
      "as fully read at migration time so the upgrade shows no false backlog; " +
      "circles joined afterwards start unread until first opened.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_read_state (
          circle_id    TEXT PRIMARY KEY,
          last_read_at INTEGER NOT NULL
        )
      `);
      // Seed existing circles as read up to their newest message → no backlog.
      db.exec(`
        INSERT OR IGNORE INTO circle_read_state (circle_id, last_read_at)
          SELECT circle_id, MAX(created_at) FROM circle_messages GROUP BY circle_id
      `);
    },
  },
  {
    version: 41,
    description:
      "PLAN-36 Phase A3 (chat shell): circle_messages.reply_to — the envelope_id " +
      "of the message a reply answers. The envelope id is stable across all nodes " +
      "(it is the dedupe key), so a reply resolves to its parent on every member's " +
      "node. Carried in the message body (reply_to), stored on both the outbound " +
      "and inbound rows; the UI renders a quoted parent. NULL on non-replies.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circle_messages", "reply_to", "TEXT");
    },
  },
  {
    version: 42,
    description:
      "PLAN-36 Phase B (agent in the room, summon-only): circle_agent_drafts — " +
      "node-LOCAL drafts the member's own agent writes on a quarantined tool-less " +
      "path when a circle message summons it with @agent. A draft is visible only " +
      "to this node's human and NEVER fans out on its own; publishing it goes " +
      "through the normal human-initiated send RPC (the consent tap). Rows are " +
      "private state, not circle content: they ride no envelope and no sync.",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_agent_drafts (
          draft_id             TEXT PRIMARY KEY,
          circle_id            TEXT NOT NULL,
          summon_envelope_id   TEXT,
          summon_author_pubkey TEXT,
          kind                 TEXT NOT NULL DEFAULT 'reply',
          status               TEXT NOT NULL DEFAULT 'queued',
          content              TEXT NOT NULL DEFAULT '',
          error                TEXT,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_circle_agent_drafts_circle
          ON circle_agent_drafts (circle_id, status);
      `);
    },
  },
  {
    version: 43,
    description:
      "PLAN-36 Phase B2 (agent-drafted card slices): circle_agent_drafts gains " +
      "target_card_id + target_slot. A kind='slice' draft is the agent " +
      "pre-filling the member's OWN contribution to a canvas card slot (a vote, " +
      "a study-guide section) on the same quarantined path; publishing it ships " +
      "through the normal circles.canvas.slice consent path. NULL on chat-reply " +
      "drafts.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circle_agent_drafts", "target_card_id", "TEXT");
      addColumnIfMissing(db, "circle_agent_drafts", "target_slot", "TEXT");
    },
  },
  {
    version: 44,
    description:
      "PLAN-36 Phase D (unfreeze): circles.freeze_reason — JSON fork evidence " +
      "(author, seq, held/offered hashes, detected_at) recorded when a ledger " +
      "fork freezes the circle, shown to the human by the recovery UI, cleared " +
      "on unfreeze. Previously the evidence lived only in the log.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circles", "freeze_reason", "TEXT");
    },
  },
  {
    version: 45,
    description:
      "PLAN-36 Phase D (review follow-up): circles.forgiven_forks — JSON audit " +
      "of fork evidence the human reviewed when unfreezing (author, seq, hashes, " +
      "forgiven_at; capped list). A forgiven author's fork REPLAYS are rejected " +
      "without re-freezing, so a member restored from backup (or a naive " +
      "griefer) cannot re-freeze the circle after review; a fork from a NEW " +
      "author still freezes. Doubles as the retained evidence trail (evidence " +
      "is moved here on unfreeze, not destroyed).",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circles", "forgiven_forks", "TEXT");
    },
  },
  {
    version: 46,
    description:
      "PLAN-36 §5.3 completed: circle_pending_outbound becomes the HUMAN " +
      "approval queue. The v37 interim minted the confirm token at preview " +
      "time, so a prompt-injected agent could self-serve preview→confirm with " +
      "no human. Now an agent write (send/ask/log_expense) only QUEUES here " +
      "(full params + human-facing preview persisted); the inline approval " +
      "card in the Circles UI is the ONLY path that executes (circles.outbound." +
      "approve) or rejects it. status: pending|approved|rejected|expired.",
    up: (db: DatabaseSync) => {
      addColumnIfMissing(db, "circle_pending_outbound", "circle_id", "TEXT");
      addColumnIfMissing(db, "circle_pending_outbound", "params_json", "TEXT");
      addColumnIfMissing(db, "circle_pending_outbound", "preview_json", "TEXT");
      addColumnIfMissing(
        db,
        "circle_pending_outbound",
        "status",
        "TEXT NOT NULL DEFAULT 'pending'",
      );
      addColumnIfMissing(db, "circle_pending_outbound", "resolved_at", "INTEGER");
      // Legacy v37 token rows carry no params/preview and can never execute —
      // resolve them out of the pending set defensively.
      db.exec(`UPDATE circle_pending_outbound SET status = 'expired' WHERE params_json IS NULL`);
    },
  },
  {
    version: 47,
    description:
      "PLAN-36 §5.2: circle_rate_hits — PERSISTED per-member A2A rate buckets. " +
      "The friend-branch rate limiter was an in-memory sliding window that reset " +
      "(more permissively) on every gateway restart, so a worm could span a " +
      "restart to refresh its budget. Now each accepted request records a hit " +
      "row; the window count survives restart. Rows are GC'd past the max " +
      "window (bounded to ~a minute of traffic).",
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS circle_rate_hits (
          bucket_key TEXT NOT NULL,
          hit_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_circle_rate_hits_key
          ON circle_rate_hits (bucket_key, hit_at);
        CREATE INDEX IF NOT EXISTS idx_circle_rate_hits_at
          ON circle_rate_hits (hit_at);
      `);
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
