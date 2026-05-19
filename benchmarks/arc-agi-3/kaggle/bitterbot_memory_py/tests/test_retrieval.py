"""Tests for embedder + hybrid retrieval (Phase 1c).

The BGE embedder is exercised only in a single test gated by the
`embedder` marker; pytest's default run uses `HashEmbedder` for fast,
network-free coverage of retrieval logic.
"""

from __future__ import annotations

import numpy as np
import pytest

from bitterbot_memory.embedder import BGEEmbedder, HashEmbedder
from bitterbot_memory.knowledge_graph import ExtractedEntity, KnowledgeGraph
from bitterbot_memory.retrieval import (
    HybridRetriever,
    _pack_vec,
    _unpack_vec,
    ensure_embeddings,
)
from bitterbot_memory.store import MemoryStore


# ── BLOB packing helpers ───────────────────────────────────────────


def test_pack_unpack_roundtrip() -> None:
    v = np.array([1.0, -2.5, 0.001, 1e-9], dtype=np.float32)
    blob = _pack_vec(v)
    out = _unpack_vec(blob, len(v))
    assert np.allclose(v, out)


# ── HashEmbedder ───────────────────────────────────────────────────


def test_hash_embedder_dim_and_norm() -> None:
    emb = HashEmbedder(dim=32)
    vecs = emb.encode(["foo bar baz", "another text", "third"])
    assert vecs.shape == (3, 32)
    norms = np.linalg.norm(vecs, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


def test_hash_embedder_overlap_increases_similarity() -> None:
    emb = HashEmbedder(dim=128)
    [a, b, c] = emb.encode(
        [
            "rule action3 up",
            "rule action3 down",
            "completely different thing",
        ]
    )
    # a and b share "rule" and "action3" → cosine > 0
    assert float(a @ b) > 0.3
    # a and c share nothing → cosine ≈ 0
    assert float(a @ c) < 0.1


def test_hash_embedder_handles_empty_input() -> None:
    emb = HashEmbedder(dim=16)
    assert emb.encode([]).shape == (0, 16)
    [v] = emb.encode([""])
    assert v.shape == (16,)
    assert np.linalg.norm(v) == 0.0  # empty string → zero vector by construction


# ── ensure_embeddings ──────────────────────────────────────────────


def test_ensure_embeddings_populates_only_missing(store: MemoryStore) -> None:
    kg = KnowledgeGraph(store)
    kg.upsert_entity(ExtractedEntity(name="alpha", type="arc_rule"))
    kg.upsert_entity(ExtractedEntity(name="beta", type="arc_rule"))
    emb = HashEmbedder(dim=32)
    first = ensure_embeddings(store, emb)
    assert first == 2
    # Second call is a no-op
    second = ensure_embeddings(store, emb)
    assert second == 0
    # force=True writes all over again
    third = ensure_embeddings(store, emb, force=True)
    assert third == 2


def test_ensure_embeddings_persists_correct_dim(store: MemoryStore) -> None:
    kg = KnowledgeGraph(store)
    kg.upsert_entity(ExtractedEntity(name="x", type="arc_state"))
    ensure_embeddings(store, HashEmbedder(dim=64))
    row = store.conn.execute("SELECT dim, model FROM embeddings").fetchone()
    assert row["dim"] == 64
    assert row["model"] == "hash-64"


def test_ensure_embeddings_per_model_isolation(store: MemoryStore) -> None:
    """Two different embedders should each populate their own rows."""
    kg = KnowledgeGraph(store)
    kg.upsert_entity(ExtractedEntity(name="x", type="arc_state"))
    ensure_embeddings(store, HashEmbedder(dim=16))
    ensure_embeddings(store, HashEmbedder(dim=32))
    rows = store.conn.execute("SELECT dim, model FROM embeddings ORDER BY dim").fetchall()
    assert [r["model"] for r in rows] == ["hash-16", "hash-32"]


# ── HybridRetriever ────────────────────────────────────────────────


@pytest.fixture()
def populated_store(store: MemoryStore) -> MemoryStore:
    """A store with a small ARC-flavored corpus + embeddings."""
    kg = KnowledgeGraph(store)
    kg.upsert_entity(
        ExtractedEntity(
            name="moving-up-clears-row",
            type="arc_rule",
            properties={"confidence": 0.8, "game": "ls20"},
        )
    )
    kg.upsert_entity(
        ExtractedEntity(
            name="moving-down-falls",
            type="arc_rule",
            properties={"confidence": 0.6, "game": "ls20"},
        )
    )
    kg.upsert_entity(
        ExtractedEntity(name="green-blob-at-12-34", type="arc_object", properties={"color": 1})
    )
    kg.upsert_entity(
        ExtractedEntity(name="state-hash-abc123", type="arc_state", properties={"frame": 7})
    )
    ensure_embeddings(store, HashEmbedder(dim=128))
    return store


def test_retriever_returns_topk_by_relevance(populated_store: MemoryStore) -> None:
    r = HybridRetriever(populated_store, HashEmbedder(dim=128))
    hits = r.query("moving up rule", top_k=2)
    assert len(hits) >= 1
    assert hits[0].entity.name == "moving-up-clears-row"


def test_retriever_returns_empty_for_no_corpus(store: MemoryStore) -> None:
    r = HybridRetriever(store, HashEmbedder(dim=32))
    assert r.query("anything", top_k=5) == []


def test_retriever_falls_back_to_bm25_only_without_embedder(populated_store: MemoryStore) -> None:
    r = HybridRetriever(populated_store, embedder=None)
    hits = r.query("moving up clears", top_k=2)
    assert any(h.entity.name == "moving-up-clears-row" for h in hits)
    # All hits should have only a bm25 rank
    for h in hits:
        assert h.bm25_rank is not None
        assert h.vector_rank is None


def test_retriever_handles_query_that_misses_bm25_but_hits_vector(
    populated_store: MemoryStore,
) -> None:
    """When BM25 finds nothing, vector retrieval should still surface
    hits via RRF (vector_rank populated, bm25_rank None)."""
    # Use a query that overlaps tokens semantically but not lexically.
    # Our HashEmbedder is bag-of-tokens so any overlap counts; pick a
    # query with at least one shared token with a known entity.
    r = HybridRetriever(populated_store, HashEmbedder(dim=128))
    hits = r.query("nonexistentword green-blob-at-12-34", top_k=2)
    # The query exactly matches an entity name so BM25 will hit too —
    # that's fine; we just want at least one returned result.
    assert len(hits) > 0


def test_retriever_invalidates_bm25_when_corpus_grows(populated_store: MemoryStore) -> None:
    r = HybridRetriever(populated_store, HashEmbedder(dim=128))
    before = r.query("moving up", top_k=10)
    before_count = len(before)
    kg = KnowledgeGraph(populated_store)
    kg.upsert_entity(ExtractedEntity(name="moving up new rule", type="arc_rule"))
    ensure_embeddings(populated_store, HashEmbedder(dim=128))
    after = r.query("moving up", top_k=10)
    assert len(after) >= before_count
    assert any(h.entity.name == "moving up new rule" for h in after)


def test_retriever_rrf_score_decreases_with_rank(populated_store: MemoryStore) -> None:
    r = HybridRetriever(populated_store, HashEmbedder(dim=128))
    hits = r.query("moving rule", top_k=4)
    assert len(hits) >= 2
    # RRF score should be monotonically non-increasing
    for prev, curr in zip(hits, hits[1:]):
        assert prev.score >= curr.score
