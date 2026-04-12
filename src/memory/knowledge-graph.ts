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

const log = createSubsystemLogger("memory/knowledge-graph");

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
  | "event";

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
  | "caused_by";

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
          `UPDATE relationships SET weight = ?, evidence_chunk_ids = ?, updated_at = ? WHERE id = ?`,
        )
        .run(newWeight, JSON.stringify(mergedEvidence), now, existing.id);
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

    // Create new relationship
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO relationships (id, source_entity_id, target_entity_id, relation_type, weight,
           valid_from, valid_until, evidence_chunk_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );

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
    this.db
      .prepare(`UPDATE relationships SET valid_until = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, oldRelId);

    if (newRel) {
      return this.upsertRelationship(newRel);
    }
    return null;
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

    try {
      this.db.exec("BEGIN");

      for (const e of entities) {
        this.upsertEntity(e);
        entitiesUpserted++;
      }

      for (const r of relationships) {
        this.upsertRelationship(r, evidenceChunkIds);
        relationshipsUpserted++;
      }

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      log.warn(`knowledge graph ingest failed: ${String(err)}`);
      return { entitiesUpserted: 0, relationshipsUpserted: 0 };
    }

    if (entitiesUpserted + relationshipsUpserted > 0) {
      log.debug("knowledge graph ingest", { entitiesUpserted, relationshipsUpserted });
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
  getStats(): { entityCount: number; relationshipCount: number; activeRelationships: number } {
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

    return { entityCount, relationshipCount, activeRelationships };
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
