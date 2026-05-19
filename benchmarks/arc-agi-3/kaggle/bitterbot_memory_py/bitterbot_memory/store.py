"""SQLite store + schema migrations.

Mirrors the entities/relationships DDL from `src/memory/migrations.ts`
(GAP-1 Knowledge Graph migration) so the Python port can read databases
written by the TS side and vice versa. Additional ARC-AGI-3 tables for
hormonal/curiosity/epistemic state are added here as well, since those
live in JSON files in the TS side rather than the SQLite store — but on
Kaggle a single sqlite file is the cleanest persistence layer.

Schema is created idempotently on every `open_store` call. There is no
formal migration version table because the library is single-version
for the Kaggle competition; if we ever need migrations, add them with
the same `user_version` pragma the TS side uses.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


SCHEMA = [
    # ── Knowledge Graph: entities ────────────────────────────────────
    # Mirror of src/memory/migrations.ts entities table.
    """
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
    """,
    "CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)",
    "CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)",
    # ── Knowledge Graph: relationships ───────────────────────────────
    """
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
    """,
    "CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_entity_id)",
    "CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type)",
    "CREATE INDEX IF NOT EXISTS idx_rel_temporal ON relationships(valid_from, valid_until)",
    # ── ARC-AGI-3 transition log ─────────────────────────────────────
    # Records every (game_id, state_hash, action, next_state_hash)
    # tuple the agent observes. Used by curiosity.py to compute
    # novelty scores via count-based intrinsic reward.
    """
    CREATE TABLE IF NOT EXISTS arc_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        prev_state_hash TEXT NOT NULL,
        action INTEGER NOT NULL,
        next_state_hash TEXT NOT NULL,
        pixel_delta INTEGER NOT NULL DEFAULT 0,
        observed_at INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_trans_game ON arc_transitions(game_id)",
    "CREATE INDEX IF NOT EXISTS idx_trans_pair ON arc_transitions(prev_state_hash, action)",
    # ── Hormonal state ───────────────────────────────────────────────
    # Single-row table; we keep history as a separate event log if we
    # later want time series, but for the Kaggle agent's in-process
    # lifetime a singleton is sufficient.
    """
    CREATE TABLE IF NOT EXISTS hormonal_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        dopamine REAL NOT NULL,
        cortisol REAL NOT NULL,
        oxytocin REAL NOT NULL,
        updated_at INTEGER NOT NULL
    )
    """,
    # ── Hypotheses (epistemic directives) ────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS hypotheses (
        game_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        confidence REAL NOT NULL,
        refutation_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    )
    """,
    # ── Vector embeddings (BLOB-packed float32 little-endian) ────────
    # Keyed by entity id. Populated lazily when entities are upserted
    # with an embedder available.
    # Composite PK so we can store multiple embedders' vectors per
    # entity (useful for A/B'ing different models). In production
    # Kaggle agent we use one model, but tests exercise both paths.
    """
    CREATE TABLE IF NOT EXISTS embeddings (
        entity_id TEXT NOT NULL REFERENCES entities(id),
        vector BLOB NOT NULL,
        dim INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (entity_id, model)
    )
    """,
]


@dataclass
class MemoryStore:
    """Owned handle to an opened bitterbot-memory SQLite database.

    Holds the raw `sqlite3.Connection`. Submodules accept this and run
    queries against `store.conn`. The store itself is intentionally
    thin: it manages connection + schema and nothing else.
    """

    path: Path
    conn: sqlite3.Connection

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "MemoryStore":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def open_store(path: str | Path, *, read_only: bool = False) -> MemoryStore:
    """Open (or create) a memory store at `path`.

    Idempotent: runs every CREATE TABLE / CREATE INDEX in SCHEMA on
    open. Uses standard sqlite3 (Python stdlib) so it works inside the
    Kaggle container without extra wheels.
    """
    p = Path(path)
    if not read_only:
        p.parent.mkdir(parents=True, exist_ok=True)

    uri = f"file:{p}{'?mode=ro' if read_only else ''}"
    conn = sqlite3.connect(uri, uri=True, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.row_factory = sqlite3.Row

    if not read_only:
        for stmt in SCHEMA:
            conn.execute(stmt)

    return MemoryStore(path=p, conn=conn)
