/**
 * Knowledge Graph: general-purpose entity-relationship graph stored in SQLite.
 *
 * Provides structured traversal queries ("who works on project X?", "what depends on Y?")
 * that embeddings alone can't answer reliably. Entities are extracted from session
 * transcripts during the experience signal collection pipeline.
 *
 * Temporal validity on relationships enables Zep-style temporal reasoning:
 * "who was the lead in January?" vs "who is the lead now?"
 *
 * PLAN-9: GAP-1 (Knowledge Graph) + GAP-2 (Temporal Knowledge Graph)
 *
 * References:
 * - Zep/Graphiti temporal KG architecture (arxiv:2501.13956)
 * - MAGMA multi-graph (arxiv:2601.03236)
 */

import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isAdmissibleEntity, isAdmissibleRelation } from "./kg-entity-admission.js";
import { buildRelationshipTemporalWhereClause } from "./temporal-filter.js";

const log = createSubsystemLogger("memory/knowledge-graph");

/**
 * PLAN-23 SABM: relation types whose target is expected to be functionally
 * unique for a given source (one-to-one-ish). When a NEW edge of one of these
 * types arrives for a source that already has a different active target, that
 * is a candidate mutual contradiction worth flagging for dream-time
 * adjudication. Unknown relation types default to many-to-many (no flag), the
 * safe non-destructive choice. Cardinality is heuristic and only ever produces
 * a non-destructive flag at write time; the irreversible close happens later in
 * the reconsolidation dream mode after the labile window elapses.
 */
const MUTUALLY_EXCLUSIVE_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>([
  "located_at",
  "belongs_to",
]);

/** Belief-history action verbs recorded in relationship_belief_history. */
export type BeliefAction = "strengthen" | "flag_contradiction" | "update" | "supersede";

// ── Types ──

export type EntityType =
  | "person"
  | "project"
  | "concept"
  | "tool"
  | "organization"
  | "location"
  | "file"
  | "service"
  | "event"
  // PLAN-19 ARC-AGI-3 entity kinds. Additive; do not remove existing
  // values. arc_state = hash of an observed grid. arc_object = a
  // connected component within a state. arc_action = ACTION{1..7} +
  // RESET. arc_rule = a learned transition rule "ACTION3 from states
  // matching X produces Y".
  | "arc_state"
  | "arc_object"
  | "arc_action"
  | "arc_rule"
  // PLAN-24 HORMA Phase 5: an abstraction node summarizing a community of
  // entities, built offline by the graph-abstraction dream pass. Gives the
  // reader an O(log N) coarse entry point above the flat entity layer.
  | "summary";

export interface Entity {
  id: string;
  name: string;
  entityType: EntityType;
  properties: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
  mentionCount: number;
  importance: number;
}

export type RelationType =
  | "works_on"
  | "manages"
  | "depends_on"
  | "uses"
  | "created_by"
  | "belongs_to"
  | "related_to"
  | "contradicts"
  | "located_at"
  | "part_of"
  | "knows"
  | "prefers"
  | "caused_by"
  // PLAN-19 ARC-AGI-3 relation kinds. Additive; do not remove existing
  // values. transforms_into = applied to (state, action) pairs that
  // produce a target state. produces = links an arc_rule to its
  // typical outcome. observed_in = links an arc_object to an arc_state.
  // refutes = a transition observation that refutes an arc_rule.
  | "transforms_into"
  | "produces"
  | "observed_in"
  | "refutes"
  // PLAN-24 HORMA Phase 5: a summary entity summarizes a member entity.
  | "summarizes"
  // PLAN-27 graph-anchored recall: family/identity relations so "who is my
  // wife"-style entity queries resolve structurally. Gender-neutral on purpose
  // (spouse_of, not wife_of) to keep the union small; the human label is derived
  // at format time. Direction: (named person, relation, owner) — e.g. Donna
  // spouse_of Victor, Sarah parent_of Victor.
  | "spouse_of"
  | "parent_of"
  | "child_of"
  | "sibling_of";

export interface Relationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: RelationType;
  weight: number;
  validFrom: number | null;
  validUntil: number | null;
  evidenceChunkIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  properties?: Record<string, unknown>;
}

export interface ExtractedRelationship {
  sourceName: string;
  sourceType: EntityType;
  targetName: string;
  targetType: EntityType;
  relationType: RelationType;
  validFrom?: number | null;
  validUntil?: number | null;
  weight?: number;
}

export interface GraphTraversalResult {
  entity: Entity;
  relationships: Array<{
    relationship: Relationship;
    connectedEntity: Entity;
    direction: "outgoing" | "incoming";
  }>;
}

export interface GraphSearchResult {
  entityId: string;
  entityName: string;
  entityType: EntityType;
  evidenceChunkIds: string[];
  score: number;
}

// ── Knowledge Graph Manager ──

export class KnowledgeGraphManager {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ── Entity CRUD ──

  /**
   * Upsert an entity by name+type. Merges properties if existing.
   */
  upsertEntity(entity: ExtractedEntity): Entity {
    const now = Date.now();
    const normalizedName = entity.name.trim().toLowerCase();

    const existing = this.findEntityByNameType(normalizedName, entity.type);
    if (existing) {
      // Merge properties and update
      const mergedProps = { ...existing.properties, ...entity.properties };
      this.db
        .prepare(
          `UPDATE entities SET properties = ?, last_seen_at = ?, mention_count = mention_count + 1
           WHERE id = ?`,
        )
        .run(JSON.stringify(mergedProps), now, existing.id);
      return {
        ...existing,
        properties: mergedProps,
        lastSeenAt: now,
        mentionCount: existing.mentionCount + 1,
      };
    }

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO entities (id, name, entity_type, properties, first_seen_at, last_seen_at, mention_count, importance)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0.5)`,
      )
      .run(id, normalizedName, entity.type, JSON.stringify(entity.properties ?? {}), now, now);

    return {
      id,
      name: normalizedName,
      entityType: entity.type,
      properties: entity.properties ?? {},
      firstSeenAt: now,
      lastSeenAt: now,
      mentionCount: 1,
      importance: 0.5,
    };
  }

  findEntityByNameType(name: string, type: EntityType): Entity | null {
    const row = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? AND entity_type = ?`)
      .get(name.trim().toLowerCase(), type) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  findEntityById(id: string): Entity | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as
      | EntityRow
      | undefined;
    return row ? rowToEntity(row) : null;
  }

  /**
   * Search entities by name prefix (for autocomplete / fuzzy matching).
   */
  searchEntities(query: string, limit = 10): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM entities WHERE name LIKE ? ORDER BY mention_count DESC, importance DESC LIMIT ?`,
      )
      .all(`%${query.trim().toLowerCase()}%`, limit) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ── Relationship CRUD ──

  /**
   * Add or update a relationship. If an active relationship of the same type
   * exists between the same entities, supersede it by setting valid_until on the old one.
   */
  upsertRelationship(rel: ExtractedRelationship, evidenceChunkIds: string[] = []): Relationship {
    const now = Date.now();
    // SABM: set when a mutually-exclusive conflict against an existing active
    // edge is detected, so the freshly-inserted edge can be flagged below.
    let pendingContradictionWith: string | null = null;

    // Ensure both entities exist
    const source = this.upsertEntity({ name: rel.sourceName, type: rel.sourceType });
    const target = this.upsertEntity({ name: rel.targetName, type: rel.targetType });

    // Check for existing active relationship of same type between same entities
    const existing = this.db
      .prepare(
        `SELECT * FROM relationships
         WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
           AND valid_until IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(source.id, target.id, rel.relationType) as RelRow | undefined;

    if (existing) {
      // Merge evidence, update weight
      const oldEvidence: string[] = JSON.parse(existing.evidence_chunk_ids || "[]");
      const mergedEvidence = [...new Set([...oldEvidence, ...evidenceChunkIds])];
      const newWeight = Math.min(1, (existing.weight + (rel.weight ?? 0.5)) / 2 + 0.05);
      this.db
        .prepare(
          `UPDATE relationships SET weight = ?, evidence_chunk_ids = ?, updated_at = ?,
             last_reinforced_at = ? WHERE id = ?`,
        )
        .run(newWeight, JSON.stringify(mergedEvidence), now, now, existing.id);
      // SABM: non-destructive audit of the reinforcement.
      this.recordBelief(existing.id, "strengthen", existing.weight, newWeight, mergedEvidence, now);
      return {
        id: existing.id,
        sourceEntityId: source.id,
        targetEntityId: target.id,
        relationType: rel.relationType,
        weight: newWeight,
        validFrom: existing.valid_from,
        validUntil: existing.valid_until,
        evidenceChunkIds: mergedEvidence,
        createdAt: existing.created_at,
        updatedAt: now,
      };
    }

    // SABM: deterministic, NON-DESTRUCTIVE write-time contradiction detection.
    // For a mutually-exclusive relation type, a new edge whose source already
    // has a DIFFERENT active target is a candidate mutual conflict. We only
    // FLAG it (audit row); both edges stay active (valid_until NULL). The
    // irreversible close is deferred to the reconsolidation dream mode after
    // the supporting evidence's labile window elapses. Purely structural - no
    // embeddings, no LLM, so the write path stays deterministic and cheap.
    if (MUTUALLY_EXCLUSIVE_RELATIONS.has(rel.relationType)) {
      const conflict = this.db
        .prepare(
          `SELECT id FROM relationships
           WHERE source_entity_id = ? AND relation_type = ?
             AND target_entity_id != ? AND valid_until IS NULL
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(source.id, rel.relationType, target.id) as { id: string } | undefined;
      if (conflict) {
        // Flag the incoming edge id below once it is inserted.
        pendingContradictionWith = conflict.id;
      }
    }

    // Create new relationship
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, weight,
           valid_from, valid_until, evidence_chunk_ids, created_at, updated_at, last_reinforced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        source.id,
        target.id,
        rel.relationType,
        rel.weight ?? 0.5,
        rel.validFrom ?? now,
        rel.validUntil ?? null,
        JSON.stringify(evidenceChunkIds),
        now,
        now,
        now,
      );

    if (pendingContradictionWith) {
      this.recordBelief(
        id,
        "flag_contradiction",
        null,
        rel.weight ?? 0.5,
        evidenceChunkIds,
        now,
        pendingContradictionWith,
      );
    }

    return {
      id,
      sourceEntityId: source.id,
      targetEntityId: target.id,
      relationType: rel.relationType,
      weight: rel.weight ?? 0.5,
      validFrom: rel.validFrom ?? now,
      validUntil: rel.validUntil ?? null,
      evidenceChunkIds,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Supersede a relationship: close the old one and optionally create a new one.
   * Used when facts change: "Alice was lead" → "Bob is lead".
   */
  supersedeRelationship(oldRelId: string, newRel?: ExtractedRelationship): Relationship | null {
    const now = Date.now();
    const prior = this.db
      .prepare(`SELECT weight, evidence_chunk_ids FROM relationships WHERE id = ?`)
      .get(oldRelId) as { weight: number; evidence_chunk_ids: string } | undefined;
    this.db
      .prepare(`UPDATE relationships SET valid_until = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, oldRelId);
    // SABM: audit the destructive close (this is the irreversible step, only
    // ever called from the reconsolidation dream mode post-labile-window).
    this.recordBelief(
      oldRelId,
      "supersede",
      prior?.weight ?? null,
      null,
      prior ? (JSON.parse(prior.evidence_chunk_ids || "[]") as string[]) : [],
      now,
    );

    if (newRel) {
      return this.upsertRelationship(newRel);
    }
    return null;
  }

  /**
   * SABM: append a non-destructive row to relationship_belief_history. Tolerant
   * of a pre-v16 DB (the table may not exist) so callers never throw on write.
   */
  private recordBelief(
    relationshipId: string,
    action: BeliefAction,
    prevWeight: number | null,
    newWeight: number | null,
    evidenceChunkIds: string[],
    now: number,
    supersededByOrContradicts?: string,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO relationship_belief_history
             (id, relationship_id, action, prev_weight, new_weight, evidence_chunk_ids,
              valid_from, valid_until, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          relationshipId,
          action,
          prevWeight,
          newWeight,
          JSON.stringify(evidenceChunkIds),
          // valid_from carries the contradicting/superseding peer id when present,
          // reusing the column rather than widening the schema; null otherwise.
          null,
          null,
          now,
        );
      if (supersededByOrContradicts) {
        log.debug("belief flagged", {
          rel: relationshipId.slice(0, 8),
          action,
          peer: supersededByOrContradicts.slice(0, 8),
        });
      }
    } catch (err) {
      // Pre-v16 DB or transient error: never break the write path.
      log.debug(`recordBelief skipped: ${String(err)}`);
    }
  }

  // ── Graph Traversal ──

  /**
   * Get all relationships for an entity (both directions), optionally
   * filtered to only currently-valid relationships.
   */
  traverseEntity(entityId: string, currentOnly = true): GraphTraversalResult | null {
    const entity = this.findEntityById(entityId);
    if (!entity) {
      return null;
    }

    const temporalFilter = currentOnly ? " AND valid_until IS NULL" : "";

    const outgoing = this.db
      .prepare(
        `SELECT r.*, e.id as eid, e.name, e.entity_type, e.properties, e.first_seen_at,
                e.last_seen_at, e.mention_count, e.importance
         FROM relationships r
         JOIN entities e ON e.id = r.target_entity_id
         WHERE r.source_entity_id = ?${temporalFilter}
         ORDER BY r.weight DESC`,
      )
      .all(entityId) as Array<RelRow & EntityRow>;

    const incoming = this.db
      .prepare(
        `SELECT r.*, e.id as eid, e.name, e.entity_type, e.properties, e.first_seen_at,
                e.last_seen_at, e.mention_count, e.importance
         FROM relationships r
         JOIN entities e ON e.id = r.source_entity_id
         WHERE r.target_entity_id = ?${temporalFilter}
         ORDER BY r.weight DESC`,
      )
      .all(entityId) as Array<RelRow & EntityRow>;

    const relationships = [
      ...outgoing.map((r) => ({
        relationship: rowToRelationship(r),
        connectedEntity: rowToEntity(r),
        direction: "outgoing" as const,
      })),
      ...incoming.map((r) => ({
        relationship: rowToRelationship(r),
        connectedEntity: rowToEntity(r),
        direction: "incoming" as const,
      })),
    ];

    return { entity, relationships };
  }

  /**
   * SABM belief history: every active AND closed relationship for an entity as
   * the belief stood at a given transaction time. Unlike `traverseEntity`,
   * this surfaces superseded (closed) edges, so callers can answer "what did I
   * believe about X as of T?". `validAt` filters by valid-time interval;
   * omitting it returns the full interval chain (active + closed).
   */
  beliefHistory(
    entityId: string,
    opts: { validAt?: number } = {},
  ): Array<{
    relationship: Relationship;
    connectedEntity: Entity;
    direction: "outgoing" | "incoming";
  }> {
    const entity = this.findEntityById(entityId);
    if (!entity) {
      return [];
    }
    // includeClosed: true so superseded beliefs are visible; the universal
    // valid_until IS NULL guard used elsewhere is deliberately dropped here.
    const temporal = buildRelationshipTemporalWhereClause(
      { validAt: opts.validAt, includeClosed: true },
      "r",
    );
    const out = this.db
      .prepare(
        `SELECT r.*, e.id as eid, e.name, e.entity_type, e.properties, e.first_seen_at,
                e.last_seen_at, e.mention_count, e.importance
         FROM relationships r JOIN entities e ON e.id = r.target_entity_id
         WHERE r.source_entity_id = ?${temporal.sql}
         ORDER BY r.created_at DESC`,
      )
      .all(entityId, ...temporal.params) as Array<RelRow & EntityRow>;
    const inc = this.db
      .prepare(
        `SELECT r.*, e.id as eid, e.name, e.entity_type, e.properties, e.first_seen_at,
                e.last_seen_at, e.mention_count, e.importance
         FROM relationships r JOIN entities e ON e.id = r.source_entity_id
         WHERE r.target_entity_id = ?${temporal.sql}
         ORDER BY r.created_at DESC`,
      )
      .all(entityId, ...temporal.params) as Array<RelRow & EntityRow>;
    return [
      ...out.map((r) => ({
        relationship: rowToRelationship(r),
        connectedEntity: rowToEntity(r),
        direction: "outgoing" as const,
      })),
      ...inc.map((r) => ({
        relationship: rowToRelationship(r),
        connectedEntity: rowToEntity(r),
        direction: "incoming" as const,
      })),
    ];
  }

  /**
   * SABM: the belief about an entity as it stood at transaction time `ts` -
   * only edges whose valid interval contained `ts`. Convenience wrapper over
   * `beliefHistory({ validAt })`.
   */
  beliefAsOf(
    entityId: string,
    ts: number,
  ): Array<{
    relationship: Relationship;
    connectedEntity: Entity;
    direction: "outgoing" | "incoming";
  }> {
    return this.beliefHistory(entityId, { validAt: ts });
  }

  /**
   * Graph-enhanced retrieval: extract entity names from query, traverse
   * graph, and return evidence chunk IDs ranked by graph relevance.
   *
   * This is the 3rd retrieval modality for RRF fusion alongside vector + BM25.
   */
  graphSearch(queryEntities: ExtractedEntity[], limit = 20): GraphSearchResult[] {
    const results: GraphSearchResult[] = [];
    const seen = new Set<string>();

    for (const qe of queryEntities) {
      const entity = this.findEntityByNameType(qe.name, qe.type);
      if (!entity) {
        continue;
      }

      const traversal = this.traverseEntity(entity.id, true);
      if (!traversal) {
        continue;
      }

      // Add the entity itself
      for (const { relationship, connectedEntity } of traversal.relationships) {
        if (seen.has(connectedEntity.id)) {
          continue;
        }
        seen.add(connectedEntity.id);

        const score = relationship.weight * connectedEntity.importance;
        results.push({
          entityId: connectedEntity.id,
          entityName: connectedEntity.name,
          entityType: connectedEntity.entityType,
          evidenceChunkIds: relationship.evidenceChunkIds,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Temporal query: find who/what held a relationship at a specific point in time.
   * E.g., "who was the project lead in January 2026?"
   */
  queryAtTime(
    entityName: string,
    entityType: EntityType,
    relationType: RelationType,
    atTime: number,
  ): Array<{ entity: Entity; relationship: Relationship }> {
    const source = this.findEntityByNameType(entityName, entityType);
    if (!source) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT r.*, e.id as eid, e.name, e.entity_type, e.properties, e.first_seen_at,
                e.last_seen_at, e.mention_count, e.importance
         FROM relationships r
         JOIN entities e ON e.id = r.target_entity_id
         WHERE r.source_entity_id = ? AND r.relation_type = ?
           AND r.valid_from <= ?
           AND (r.valid_until IS NULL OR r.valid_until > ?)
         ORDER BY r.weight DESC`,
      )
      .all(source.id, relationType, atTime, atTime) as Array<RelRow & EntityRow>;

    return rows.map((r) => ({
      entity: rowToEntity(r),
      relationship: rowToRelationship(r),
    }));
  }

  // ── Batch Ingest (from session extraction) ──

  /**
   * Ingest entities and relationships extracted from a session transcript.
   * Called during the experience signal collection pipeline.
   */
  ingestExtraction(
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[],
    evidenceChunkIds: string[] = [],
  ): { entitiesUpserted: number; relationshipsUpserted: number } {
    let entitiesUpserted = 0;
    let relationshipsUpserted = 0;
    let skipped = 0;

    try {
      this.db.exec("BEGIN");

      // ADMISSION CONTROL (2026-08-11). Every write funnels through here, so
      // this is the one place that can guarantee the graph stays sane. Prior
      // to this gate five callers each had their own (or no) validation, and
      // the graph filled with `are`/`could`/`water` typed as people. Rejected
      // candidates are dropped silently-but-countably: a skipped edge is a
      // non-event, a wrong edge is a lasting lie.
      const admissibleNames = new Set<string>();
      for (const e of entities) {
        if (!isAdmissibleEntity(e.name, e.type)) {
          skipped++;
          continue;
        }
        this.upsertEntity(e);
        admissibleNames.add(e.name.trim().toLowerCase());
        entitiesUpserted++;
      }

      for (const r of relationships) {
        // An edge is only as good as its endpoints: refuse it when either end
        // failed admission, otherwise upsertRelationship would re-create the
        // junk entity we just refused.
        if (
          !isAdmissibleEntity(r.sourceName, r.sourceType) ||
          !isAdmissibleEntity(r.targetName, r.targetType) ||
          // Type-pair constraint: `prefers` needs a concept-ish object,
          // `located_at` needs a place. This is what makes the junk classes
          // structurally inexpressible instead of merely filtered.
          !isAdmissibleRelation(r.sourceType, r.relationType, r.targetType)
        ) {
          skipped++;
          continue;
        }
        this.upsertRelationship(r, evidenceChunkIds);
        relationshipsUpserted++;
      }
      void admissibleNames;

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      log.warn(`knowledge graph ingest failed: ${String(err)}`);
      return { entitiesUpserted: 0, relationshipsUpserted: 0 };
    }

    if (entitiesUpserted + relationshipsUpserted > 0 || skipped > 0) {
      log.debug("knowledge graph ingest", { entitiesUpserted, relationshipsUpserted, skipped });
    }

    return { entitiesUpserted, relationshipsUpserted };
  }

  // ── Maintenance (dream integration) ──

  /**
   * Prune relationships that haven't been reinforced with new evidence
   * in the specified number of days. Called during dream cycles.
   */
  pruneStaleRelationships(staleDays = 30): number {
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
    try {
      const result = this.db
        .prepare(
          `UPDATE relationships SET valid_until = ?
           WHERE valid_until IS NULL AND updated_at < ? AND weight < 0.5`,
        )
        .run(Date.now(), cutoff);
      const pruned = (result as { changes: number }).changes;
      if (pruned > 0) {
        log.debug(`pruned ${pruned} stale relationships`);
      }
      return pruned;
    } catch (err) {
      log.warn(`prune stale relationships failed: ${String(err)}`);
      return 0;
    }
  }

  /**
   * Merge duplicate entities (same name, different casing or slightly different names).
   * Returns number of entities merged.
   */
  mergeduplicateEntities(): number {
    // Find entities with identical lowercase names and same type
    const dupes = this.db
      .prepare(
        `SELECT entity_type, name, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
         FROM entities
         GROUP BY entity_type, name
         HAVING cnt > 1`,
      )
      .all() as Array<{ entity_type: string; name: string; cnt: number; ids: string }>;

    let merged = 0;
    for (const dupe of dupes) {
      const ids = dupe.ids.split(",");
      if (ids.length < 2) {
        continue;
      }

      const keepId = ids[0]!;
      const removeIds = ids.slice(1);

      try {
        this.db.exec("BEGIN");
        for (const removeId of removeIds) {
          // Repoint relationships
          this.db
            .prepare(`UPDATE relationships SET source_entity_id = ? WHERE source_entity_id = ?`)
            .run(keepId, removeId);
          this.db
            .prepare(`UPDATE relationships SET target_entity_id = ? WHERE target_entity_id = ?`)
            .run(keepId, removeId);
          // Transfer mention count
          this.db
            .prepare(
              `UPDATE entities SET mention_count = mention_count + (SELECT mention_count FROM entities WHERE id = ?) WHERE id = ?`,
            )
            .run(removeId, keepId);
          // Delete duplicate
          this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(removeId);
          merged++;
        }
        this.db.exec("COMMIT");
      } catch {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
      }
    }
    return merged;
  }

  /**
   * Get graph statistics for telemetry.
   */
  getStats(): {
    entityCount: number;
    relationshipCount: number;
    activeRelationships: number;
    closedRelationships: number;
    flaggedContradictions: number;
    beliefRevisions: number;
    reinforcements: number;
  } {
    const entityCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number })?.c ?? 0;
    const relationshipCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM relationships`).get() as { c: number })?.c ?? 0;
    const activeRelationships =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM relationships WHERE valid_until IS NULL`)
          .get() as { c: number }
      )?.c ?? 0;
    const closedRelationships =
      (
        this.db
          .prepare(`SELECT COUNT(*) as c FROM relationships WHERE valid_until IS NOT NULL`)
          .get() as { c: number }
      )?.c ?? 0;

    // SABM belief-history counters. Defensive: a pre-v16 DB lacks the table,
    // so any failure yields 0 rather than throwing.
    const beliefCount = (action: string): number => {
      try {
        return (
          (
            this.db
              .prepare(`SELECT COUNT(*) as c FROM relationship_belief_history WHERE action = ?`)
              .get(action) as { c: number }
          )?.c ?? 0
        );
      } catch {
        return 0;
      }
    };

    return {
      entityCount,
      relationshipCount,
      activeRelationships,
      closedRelationships,
      flaggedContradictions: beliefCount("flag_contradiction"),
      beliefRevisions: beliefCount("supersede"),
      reinforcements: beliefCount("strengthen"),
    };
  }
}

// ── Internal row types ──

type EntityRow = {
  id: string;
  name: string;
  entity_type: string;
  properties: string;
  first_seen_at: number;
  last_seen_at: number;
  mention_count: number;
  importance: number;
  // Alias fields from JOINed queries
  eid?: string;
};

type RelRow = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  weight: number;
  valid_from: number | null;
  valid_until: number | null;
  evidence_chunk_ids: string;
  created_at: number;
  updated_at: number;
};

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.eid ?? row.id,
    name: row.name,
    entityType: row.entity_type as EntityType,
    properties: JSON.parse(row.properties || "{}"),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mentionCount: row.mention_count,
    importance: row.importance,
  };
}

function rowToRelationship(row: RelRow): Relationship {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationType: row.relation_type as RelationType,
    weight: row.weight,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    evidenceChunkIds: JSON.parse(row.evidence_chunk_ids || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
