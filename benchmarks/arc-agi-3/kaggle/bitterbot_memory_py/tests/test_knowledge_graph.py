"""KnowledgeGraph CRUD tests — parity with TS KnowledgeGraphManager."""

from __future__ import annotations

import time

import pytest

from bitterbot_memory.knowledge_graph import (
    ExtractedEntity,
    ExtractedRelationship,
    KnowledgeGraph,
)
from bitterbot_memory.store import MemoryStore


@pytest.fixture()
def kg(store: MemoryStore) -> KnowledgeGraph:
    return KnowledgeGraph(store)


# ── Entity upserts ─────────────────────────────────────────────────


def test_upsert_entity_creates_new_when_absent(kg: KnowledgeGraph) -> None:
    e = kg.upsert_entity(ExtractedEntity(name="ACTION3", type="arc_action"))
    assert e.name == "action3"
    assert e.entity_type == "arc_action"
    assert e.mention_count == 1
    assert e.importance == 0.5
    assert kg.find_entity_by_id(e.id) == e


def test_upsert_entity_normalizes_name_to_lowercase_trimmed(kg: KnowledgeGraph) -> None:
    e = kg.upsert_entity(ExtractedEntity(name="  Left  ", type="arc_action"))
    assert e.name == "left"


def test_upsert_entity_reinforces_existing_via_mention_count(kg: KnowledgeGraph) -> None:
    e1 = kg.upsert_entity(ExtractedEntity(name="grid", type="arc_state"))
    e2 = kg.upsert_entity(ExtractedEntity(name="grid", type="arc_state"))
    e3 = kg.upsert_entity(ExtractedEntity(name="grid", type="arc_state"))
    assert e1.id == e2.id == e3.id
    assert e3.mention_count == 3


def test_upsert_entity_merges_properties(kg: KnowledgeGraph) -> None:
    a = kg.upsert_entity(
        ExtractedEntity(name="rule-1", type="arc_rule", properties={"confidence": 0.4})
    )
    b = kg.upsert_entity(
        ExtractedEntity(name="rule-1", type="arc_rule", properties={"evidence": "frame_007"})
    )
    assert a.id == b.id
    assert b.properties == {"confidence": 0.4, "evidence": "frame_007"}


def test_upsert_entity_overwrites_property_on_repeat_key(kg: KnowledgeGraph) -> None:
    kg.upsert_entity(ExtractedEntity(name="rule-2", type="arc_rule", properties={"c": 0.4}))
    final = kg.upsert_entity(ExtractedEntity(name="rule-2", type="arc_rule", properties={"c": 0.9}))
    assert final.properties == {"c": 0.9}


def test_upsert_entity_distinguishes_same_name_different_type(kg: KnowledgeGraph) -> None:
    a = kg.upsert_entity(ExtractedEntity(name="reset", type="arc_action"))
    b = kg.upsert_entity(ExtractedEntity(name="reset", type="event"))
    assert a.id != b.id


def test_upsert_entity_bumps_last_seen_at(kg: KnowledgeGraph) -> None:
    e1 = kg.upsert_entity(ExtractedEntity(name="frame", type="arc_state"))
    time.sleep(0.005)
    e2 = kg.upsert_entity(ExtractedEntity(name="frame", type="arc_state"))
    assert e2.last_seen_at >= e1.last_seen_at
    # first_seen_at must not be updated
    assert e2.first_seen_at == e1.first_seen_at


# ── Entity queries ─────────────────────────────────────────────────


def test_find_entity_by_name_type_normalizes(kg: KnowledgeGraph) -> None:
    kg.upsert_entity(ExtractedEntity(name="Action3", type="arc_action"))
    assert kg.find_entity_by_name_type("ACTION3", "arc_action") is not None
    assert kg.find_entity_by_name_type("action3", "arc_action") is not None


def test_search_entities_substring_match(kg: KnowledgeGraph) -> None:
    for n in ["rule-up-1", "rule-up-2", "rule-down-1", "noise"]:
        kg.upsert_entity(ExtractedEntity(name=n, type="arc_rule"))
    hits = kg.search_entities("rule-up", limit=10)
    assert {h.name for h in hits} == {"rule-up-1", "rule-up-2"}


def test_search_entities_ranks_by_mention_count(kg: KnowledgeGraph) -> None:
    kg.upsert_entity(ExtractedEntity(name="alpha", type="arc_rule"))
    for _ in range(5):
        kg.upsert_entity(ExtractedEntity(name="beta", type="arc_rule"))
    hits = kg.search_entities("a", limit=10)
    # beta should rank above alpha by mention_count
    names = [h.name for h in hits]
    assert names.index("beta") < names.index("alpha")


def test_list_entities_by_type_filters_correctly(kg: KnowledgeGraph) -> None:
    kg.upsert_entity(ExtractedEntity(name="a", type="arc_state"))
    kg.upsert_entity(ExtractedEntity(name="b", type="arc_action"))
    kg.upsert_entity(ExtractedEntity(name="c", type="arc_state"))
    states = kg.list_entities_by_type("arc_state")
    assert {e.name for e in states} == {"a", "c"}


# ── Relationship upserts ───────────────────────────────────────────


def test_upsert_relationship_creates_entities_and_link(kg: KnowledgeGraph) -> None:
    r = kg.upsert_relationship(
        ExtractedRelationship(
            source_name="state-A",
            source_type="arc_state",
            target_name="state-B",
            target_type="arc_state",
            relation_type="transforms_into",
            weight=0.6,
        )
    )
    assert r.weight == 0.6
    assert kg.find_entity_by_name_type("state-a", "arc_state") is not None
    assert kg.find_entity_by_name_type("state-b", "arc_state") is not None


def test_upsert_relationship_merges_evidence_dedupes(kg: KnowledgeGraph) -> None:
    rel = ExtractedRelationship(
        source_name="s",
        source_type="arc_state",
        target_name="t",
        target_type="arc_state",
        relation_type="transforms_into",
        weight=0.5,
    )
    r1 = kg.upsert_relationship(rel, evidence_chunk_ids=["e1", "e2"])
    r2 = kg.upsert_relationship(rel, evidence_chunk_ids=["e2", "e3"])
    assert r1.id == r2.id  # same active row
    assert set(r2.evidence_chunk_ids) == {"e1", "e2", "e3"}


def test_upsert_relationship_weight_merge_formula(kg: KnowledgeGraph) -> None:
    rel = ExtractedRelationship(
        source_name="s",
        source_type="arc_state",
        target_name="t",
        target_type="arc_state",
        relation_type="produces",
        weight=0.5,
    )
    kg.upsert_relationship(rel)  # weight = 0.5
    # Second upsert with weight 0.5 → min(1, (0.5 + 0.5)/2 + 0.05) = 0.55
    r2 = kg.upsert_relationship(
        ExtractedRelationship(
            source_name="s",
            source_type="arc_state",
            target_name="t",
            target_type="arc_state",
            relation_type="produces",
            weight=0.5,
        )
    )
    assert r2.weight == pytest.approx(0.55, abs=1e-6)


def test_upsert_relationship_weight_caps_at_one(kg: KnowledgeGraph) -> None:
    rel = ExtractedRelationship(
        source_name="s",
        source_type="arc_state",
        target_name="t",
        target_type="arc_state",
        relation_type="produces",
        weight=1.0,
    )
    kg.upsert_relationship(rel)
    for _ in range(20):
        out = kg.upsert_relationship(rel)
    assert out.weight == pytest.approx(1.0, abs=1e-6)


# ── Relationship queries ───────────────────────────────────────────


def test_find_relationships_directions(kg: KnowledgeGraph) -> None:
    kg.upsert_relationship(
        ExtractedRelationship(
            source_name="A",
            source_type="arc_state",
            target_name="B",
            target_type="arc_state",
            relation_type="transforms_into",
        )
    )
    a = kg.find_entity_by_name_type("a", "arc_state")
    b = kg.find_entity_by_name_type("b", "arc_state")
    assert a is not None and b is not None

    assert len(kg.find_relationships(a.id, direction="outgoing")) == 1
    assert len(kg.find_relationships(a.id, direction="incoming")) == 0
    assert len(kg.find_relationships(b.id, direction="incoming")) == 1
    assert len(kg.find_relationships(b.id, direction="outgoing")) == 0
    assert len(kg.find_relationships(a.id, direction="both")) == 1


def test_supersede_relationship_excludes_from_active_queries(kg: KnowledgeGraph) -> None:
    r = kg.upsert_relationship(
        ExtractedRelationship(
            source_name="A",
            source_type="arc_state",
            target_name="B",
            target_type="arc_state",
            relation_type="transforms_into",
        )
    )
    kg.supersede_relationship(r.id)
    a = kg.find_entity_by_name_type("a", "arc_state")
    assert a is not None
    assert len(kg.find_relationships(a.id, active_only=True)) == 0
    assert len(kg.find_relationships(a.id, active_only=False)) == 1


# ── Stats ──────────────────────────────────────────────────────────


def test_stats_reports_counts(kg: KnowledgeGraph) -> None:
    kg.upsert_entity(ExtractedEntity(name="a", type="arc_state"))
    kg.upsert_entity(ExtractedEntity(name="b", type="arc_state"))
    rel = kg.upsert_relationship(
        ExtractedRelationship(
            source_name="a",
            source_type="arc_state",
            target_name="b",
            target_type="arc_state",
            relation_type="transforms_into",
        )
    )
    s = kg.stats()
    assert s["entities"] == 2
    assert s["relationships"] == 1
    assert s["active_relationships"] == 1
    kg.supersede_relationship(rel.id)
    assert kg.stats()["active_relationships"] == 0
