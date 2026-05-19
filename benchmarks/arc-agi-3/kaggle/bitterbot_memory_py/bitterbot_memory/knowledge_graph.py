"""Knowledge graph CRUD.

Python port of `src/memory/knowledge-graph.ts`'s `KnowledgeGraphManager`.
Mirrors the TS upsert-by-(name,type) semantics, `mention_count`
reinforcement on duplicate upserts, and the same relationship
weight-merging formula (`min(1, (old + new) / 2 + 0.05)`).

ARC-AGI-3 entity types added in PLAN-19:
  - arc_state, arc_object, arc_action, arc_rule

ARC-AGI-3 relation types added in PLAN-19:
  - transforms_into, produces, observed_in, refutes
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

from .store import MemoryStore


EntityType = Literal[
    # Pre-PLAN-19 types from the TS side.
    "person",
    "project",
    "concept",
    "tool",
    "organization",
    "location",
    "file",
    "service",
    "event",
    # PLAN-19 ARC-AGI-3 types.
    "arc_state",
    "arc_object",
    "arc_action",
    "arc_rule",
]


RelationType = Literal[
    "works_on",
    "manages",
    "depends_on",
    "uses",
    "created_by",
    "belongs_to",
    "related_to",
    "contradicts",
    "located_at",
    "part_of",
    "knows",
    "prefers",
    "caused_by",
    # PLAN-19 ARC-AGI-3 relations.
    "transforms_into",
    "produces",
    "observed_in",
    "refutes",
]


@dataclass
class Entity:
    id: str
    name: str
    entity_type: EntityType
    properties: dict[str, Any]
    first_seen_at: int
    last_seen_at: int
    mention_count: int
    importance: float


@dataclass
class Relationship:
    id: str
    source_entity_id: str
    target_entity_id: str
    relation_type: RelationType
    weight: float
    valid_from: int | None
    valid_until: int | None
    evidence_chunk_ids: list[str]
    created_at: int
    updated_at: int


@dataclass
class ExtractedEntity:
    name: str
    type: EntityType
    properties: dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractedRelationship:
    source_name: str
    source_type: EntityType
    target_name: str
    target_type: EntityType
    relation_type: RelationType
    weight: float | None = None
    valid_from: int | None = None
    valid_until: int | None = None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _normalize_name(s: str) -> str:
    return s.strip().lower()


def _row_to_entity(row: Any) -> Entity:
    return Entity(
        id=row["id"],
        name=row["name"],
        entity_type=row["entity_type"],
        properties=json.loads(row["properties"] or "{}"),
        first_seen_at=row["first_seen_at"],
        last_seen_at=row["last_seen_at"],
        mention_count=row["mention_count"],
        importance=row["importance"],
    )


def _row_to_relationship(row: Any) -> Relationship:
    return Relationship(
        id=row["id"],
        source_entity_id=row["source_entity_id"],
        target_entity_id=row["target_entity_id"],
        relation_type=row["relation_type"],
        weight=row["weight"],
        valid_from=row["valid_from"],
        valid_until=row["valid_until"],
        evidence_chunk_ids=json.loads(row["evidence_chunk_ids"] or "[]"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class KnowledgeGraph:
    """Entity + relation store backed by SQLite.

    Holds a borrowed reference to a `MemoryStore`; does not own the
    connection lifecycle. Caller is responsible for opening and
    closing the store.
    """

    def __init__(self, store: MemoryStore) -> None:
        self._store = store
        self._conn = store.conn

    # ── Entity CRUD ────────────────────────────────────────────────

    def upsert_entity(self, entity: ExtractedEntity) -> Entity:
        """Insert-or-merge an entity keyed on (normalized name, type).

        On duplicate: merges `properties`, increments `mention_count`,
        bumps `last_seen_at`. Returns the post-upsert entity row.
        """
        now = _now_ms()
        name = _normalize_name(entity.name)
        existing = self.find_entity_by_name_type(name, entity.type)
        if existing is not None:
            merged_props = {**existing.properties, **entity.properties}
            self._conn.execute(
                "UPDATE entities SET properties = ?, last_seen_at = ?,"
                " mention_count = mention_count + 1 WHERE id = ?",
                (json.dumps(merged_props), now, existing.id),
            )
            return Entity(
                id=existing.id,
                name=existing.name,
                entity_type=existing.entity_type,
                properties=merged_props,
                first_seen_at=existing.first_seen_at,
                last_seen_at=now,
                mention_count=existing.mention_count + 1,
                importance=existing.importance,
            )

        entity_id = str(uuid.uuid4())
        self._conn.execute(
            "INSERT INTO entities"
            " (id, name, entity_type, properties, first_seen_at, last_seen_at,"
            "  mention_count, importance)"
            " VALUES (?, ?, ?, ?, ?, ?, 1, 0.5)",
            (entity_id, name, entity.type, json.dumps(entity.properties), now, now),
        )
        return Entity(
            id=entity_id,
            name=name,
            entity_type=entity.type,
            properties=dict(entity.properties),
            first_seen_at=now,
            last_seen_at=now,
            mention_count=1,
            importance=0.5,
        )

    def find_entity_by_name_type(self, name: str, type: EntityType) -> Entity | None:
        row = self._conn.execute(
            "SELECT * FROM entities WHERE name = ? AND entity_type = ?",
            (_normalize_name(name), type),
        ).fetchone()
        return _row_to_entity(row) if row else None

    def find_entity_by_id(self, entity_id: str) -> Entity | None:
        row = self._conn.execute(
            "SELECT * FROM entities WHERE id = ?", (entity_id,)
        ).fetchone()
        return _row_to_entity(row) if row else None

    def search_entities(self, query: str, limit: int = 10) -> list[Entity]:
        """Substring match on `name`, ordered by mention_count + importance."""
        rows = self._conn.execute(
            "SELECT * FROM entities WHERE name LIKE ?"
            " ORDER BY mention_count DESC, importance DESC LIMIT ?",
            (f"%{_normalize_name(query)}%", limit),
        ).fetchall()
        return [_row_to_entity(r) for r in rows]

    def list_entities_by_type(self, type: EntityType, limit: int = 100) -> list[Entity]:
        rows = self._conn.execute(
            "SELECT * FROM entities WHERE entity_type = ?"
            " ORDER BY mention_count DESC, last_seen_at DESC LIMIT ?",
            (type, limit),
        ).fetchall()
        return [_row_to_entity(r) for r in rows]

    # ── Relationship CRUD ──────────────────────────────────────────

    def upsert_relationship(
        self,
        rel: ExtractedRelationship,
        evidence_chunk_ids: Iterable[str] = (),
    ) -> Relationship:
        """Insert-or-merge a relationship between two entities.

        Mirrors the TS semantics: if an active (valid_until IS NULL)
        relationship of the same (source, target, relation_type)
        already exists, this merges evidence sets and updates weight
        via `min(1, (existing + new) / 2 + 0.05)`. Otherwise creates a
        new row. Source and target entities are upserted first.
        """
        now = _now_ms()
        source = self.upsert_entity(ExtractedEntity(name=rel.source_name, type=rel.source_type))
        target = self.upsert_entity(ExtractedEntity(name=rel.target_name, type=rel.target_type))

        existing_row = self._conn.execute(
            "SELECT * FROM relationships"
            " WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?"
            "   AND valid_until IS NULL"
            " ORDER BY created_at DESC LIMIT 1",
            (source.id, target.id, rel.relation_type),
        ).fetchone()

        new_evidence = list(evidence_chunk_ids)
        if existing_row is not None:
            old_evidence = json.loads(existing_row["evidence_chunk_ids"] or "[]")
            merged = list(dict.fromkeys([*old_evidence, *new_evidence]))
            old_weight = existing_row["weight"]
            new_weight = min(1.0, (old_weight + (rel.weight if rel.weight is not None else 0.5)) / 2 + 0.05)
            self._conn.execute(
                "UPDATE relationships SET weight = ?, evidence_chunk_ids = ?, updated_at = ?"
                " WHERE id = ?",
                (new_weight, json.dumps(merged), now, existing_row["id"]),
            )
            return Relationship(
                id=existing_row["id"],
                source_entity_id=source.id,
                target_entity_id=target.id,
                relation_type=rel.relation_type,
                weight=new_weight,
                valid_from=existing_row["valid_from"],
                valid_until=existing_row["valid_until"],
                evidence_chunk_ids=merged,
                created_at=existing_row["created_at"],
                updated_at=now,
            )

        rel_id = str(uuid.uuid4())
        weight = rel.weight if rel.weight is not None else 0.5
        self._conn.execute(
            "INSERT INTO relationships"
            " (id, source_entity_id, target_entity_id, relation_type, weight,"
            "  valid_from, valid_until, evidence_chunk_ids, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                rel_id,
                source.id,
                target.id,
                rel.relation_type,
                weight,
                rel.valid_from,
                rel.valid_until,
                json.dumps(new_evidence),
                now,
                now,
            ),
        )
        return Relationship(
            id=rel_id,
            source_entity_id=source.id,
            target_entity_id=target.id,
            relation_type=rel.relation_type,
            weight=weight,
            valid_from=rel.valid_from,
            valid_until=rel.valid_until,
            evidence_chunk_ids=new_evidence,
            created_at=now,
            updated_at=now,
        )

    def find_relationships(
        self,
        entity_id: str,
        *,
        direction: Literal["outgoing", "incoming", "both"] = "both",
        relation_type: RelationType | None = None,
        active_only: bool = True,
    ) -> list[Relationship]:
        clauses: list[str] = []
        params: list[Any] = []
        if direction == "outgoing":
            clauses.append("source_entity_id = ?")
            params.append(entity_id)
        elif direction == "incoming":
            clauses.append("target_entity_id = ?")
            params.append(entity_id)
        else:
            clauses.append("(source_entity_id = ? OR target_entity_id = ?)")
            params.extend([entity_id, entity_id])
        if relation_type is not None:
            clauses.append("relation_type = ?")
            params.append(relation_type)
        if active_only:
            clauses.append("valid_until IS NULL")

        sql = f"SELECT * FROM relationships WHERE {' AND '.join(clauses)} ORDER BY updated_at DESC"
        rows = self._conn.execute(sql, params).fetchall()
        return [_row_to_relationship(r) for r in rows]

    def supersede_relationship(self, rel_id: str) -> None:
        """Mark a relationship as no longer valid (sets `valid_until`)."""
        now = _now_ms()
        self._conn.execute(
            "UPDATE relationships SET valid_until = ?, updated_at = ? WHERE id = ?",
            (now, now, rel_id),
        )

    # ── Stats / introspection ──────────────────────────────────────

    def stats(self) -> dict[str, int]:
        e = self._conn.execute("SELECT COUNT(*) as c FROM entities").fetchone()["c"]
        r_total = self._conn.execute("SELECT COUNT(*) as c FROM relationships").fetchone()["c"]
        r_active = self._conn.execute(
            "SELECT COUNT(*) as c FROM relationships WHERE valid_until IS NULL"
        ).fetchone()["c"]
        return {"entities": e, "relationships": r_total, "active_relationships": r_active}
