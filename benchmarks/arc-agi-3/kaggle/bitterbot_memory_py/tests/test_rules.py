"""RuleStore tests — duplicate-text reinforcement + evidence accumulation."""

from __future__ import annotations

import pytest

from bitterbot_memory.rules import RuleStore
from bitterbot_memory.store import MemoryStore


def test_record_new_rule_persists_with_defaults(store: MemoryStore) -> None:
    rs = RuleStore(store)
    # KnowledgeGraph normalizes entity names to lowercase + trimmed; rules
    # use the same name field, so callers see the normalized form back.
    r = rs.record("game-abc", "ACTION3 moves the cursor up")
    assert r.rule == "action3 moves the cursor up"
    assert r.game_id == "game-abc"
    assert r.confidence == 0.5
    assert r.mention_count == 1
    assert r.evidence == []


def test_record_duplicate_rule_reinforces_mention_count(store: MemoryStore) -> None:
    rs = RuleStore(store)
    rs.record("game-abc", "duplicate-text-rule", confidence=0.4)
    r2 = rs.record("game-abc", "duplicate-text-rule", confidence=0.4)
    assert r2.mention_count == 2


def test_record_appends_evidence_dedupes(store: MemoryStore) -> None:
    rs = RuleStore(store)
    rs.record("game-abc", "rule-1", evidence="frame_007")
    rs.record("game-abc", "rule-1", evidence="frame_009")
    r3 = rs.record("game-abc", "rule-1", evidence="frame_007")  # dup
    assert set(r3.evidence) == {"frame_007", "frame_009"}


def test_record_normalizes_name_to_lowercase(store: MemoryStore) -> None:
    """Names go through KnowledgeGraph normalization (lowercase, trim)."""
    rs = RuleStore(store)
    rs.record("game-abc", "  Mixed Case Rule  ")
    rules = rs.list_for_game("game-abc")
    assert any("mixed case rule" == r.rule for r in rules)


def test_record_rejects_empty_rule(store: MemoryStore) -> None:
    rs = RuleStore(store)
    with pytest.raises(ValueError):
        rs.record("game-abc", "   ")


def test_list_for_game_filters_correctly(store: MemoryStore) -> None:
    rs = RuleStore(store)
    rs.record("game-A", "rule-1")
    rs.record("game-A", "rule-2")
    rs.record("game-B", "rule-3")
    a = rs.list_for_game("game-A")
    b = rs.list_for_game("game-B")
    assert {r.rule for r in a} == {"rule-1", "rule-2"}
    assert {r.rule for r in b} == {"rule-3"}


def test_list_for_game_orders_by_mention_count(store: MemoryStore) -> None:
    rs = RuleStore(store)
    rs.record("g", "less-seen")
    for _ in range(5):
        rs.record("g", "very-popular")
    rules = rs.list_for_game("g")
    assert rules[0].rule == "very-popular"
    assert rules[0].mention_count >= rules[1].mention_count


def test_confidence_updates_on_reinforcement(store: MemoryStore) -> None:
    rs = RuleStore(store)
    rs.record("g", "r", confidence=0.3)
    r = rs.record("g", "r", confidence=0.9)
    # KG's upsert merges properties (last write wins on same key)
    assert r.confidence == pytest.approx(0.9)
