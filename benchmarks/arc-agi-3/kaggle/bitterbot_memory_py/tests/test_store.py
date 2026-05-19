"""Phase 1a smoke tests: schema migration is idempotent + all tables exist."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from bitterbot_memory.store import MemoryStore, open_store


EXPECTED_TABLES = {
    "entities",
    "relationships",
    "arc_transitions",
    "hormonal_state",
    "hypotheses",
    "embeddings",
}


def _tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {r["name"] for r in rows}


def _indexes(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r["name"] for r in rows}


def test_open_store_creates_all_tables(store: MemoryStore) -> None:
    assert EXPECTED_TABLES.issubset(_tables(store.conn))


def test_open_store_creates_expected_indexes(store: MemoryStore) -> None:
    idx = _indexes(store.conn)
    # Cherry-pick critical indexes; full set is implementation detail.
    assert "idx_entities_type" in idx
    assert "idx_rel_type" in idx
    assert "idx_trans_pair" in idx


def test_open_store_is_idempotent(tmp_path: Path) -> None:
    """Re-opening the same path must not raise (CREATE IF NOT EXISTS)."""
    p = tmp_path / "memory.sqlite"
    s1 = open_store(p)
    s1.close()
    s2 = open_store(p)
    s2.close()


def test_store_enforces_unique_entity_name_type(store: MemoryStore) -> None:
    store.conn.execute(
        "INSERT INTO entities (id, name, entity_type, first_seen_at, last_seen_at)"
        " VALUES (?, ?, ?, ?, ?)",
        ("e1", "left", "arc_action", 0, 0),
    )
    # Same (name, entity_type) → must fail (UNIQUE constraint)
    try:
        store.conn.execute(
            "INSERT INTO entities (id, name, entity_type, first_seen_at, last_seen_at)"
            " VALUES (?, ?, ?, ?, ?)",
            ("e2", "left", "arc_action", 0, 0),
        )
    except sqlite3.IntegrityError:
        return
    assert False, "UNIQUE(name, entity_type) was not enforced"


def test_store_enforces_foreign_key_on_relationships(store: MemoryStore) -> None:
    # Without inserting the parent entities, relationships row should fail.
    try:
        store.conn.execute(
            "INSERT INTO relationships"
            " (id, source_entity_id, target_entity_id, relation_type, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            ("r1", "ghost-source", "ghost-target", "related_to", 0, 0),
        )
    except sqlite3.IntegrityError:
        return
    assert False, "Foreign key not enforced on relationships"


def test_store_singleton_hormonal_constraint(store: MemoryStore) -> None:
    store.conn.execute(
        "INSERT INTO hormonal_state (id, dopamine, cortisol, oxytocin, updated_at)"
        " VALUES (1, 0.5, 0.0, 0.5, 0)"
    )
    # id=2 must fail (CHECK constraint)
    try:
        store.conn.execute(
            "INSERT INTO hormonal_state (id, dopamine, cortisol, oxytocin, updated_at)"
            " VALUES (2, 0.5, 0.0, 0.5, 0)"
        )
    except sqlite3.IntegrityError:
        return
    assert False, "CHECK (id = 1) on hormonal_state was not enforced"
